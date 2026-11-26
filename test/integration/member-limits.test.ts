// Member and admin rate limits with production timing: no TEST_TIMING, so the platform bindings are live.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declaredRateLimits } from "../env-vars.ts";
import { inOneWindow } from "./open-client.ts";
import { PEPPER } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
beforeAll(async () => {
  wrangler = await startWrangler({ HASH_PEPPER: PEPPER }, { migrate: true });
});
afterAll(() => wrangler?.stop());

const IP_LIMIT = declaredRateLimits().RL_MEMBER_IP ?? 0;
/** Room left in one window for a burst one past RL_MEMBER_IP, inside the 30 s test timeout with the wait. */
const BURST_MS = 20_000;

const post = async (path: string, ip: string) => {
  const res = await fetch(`${wrangler.url}${path}`, {
    method: "POST",
    headers: { Origin: wrangler.url, "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: "{}",
  });
  return { status: res.status, body: await res.text() };
};

describe("AUTH-16 admin and the member limits, with real limits", () => {
  it("AUTH-16 admin: a non-admin probe of /api/admin/* answers as an unknown /api/* path at every one of 70 requests", async () => {
    for (let i = 1; i <= 70; i++) {
      const admin = await post("/api/admin/view", "203.0.113.20");
      const unknown = await post("/api/no-such-path", "203.0.113.20");
      expect(admin, `request ${i}`).toEqual(unknown);
      expect(admin.status).toBe(404);
    }
  });

  it("AUTH-19 meter: a member write spends the coarse per-IP guard: 300 a minute, then 429, before any session read", async () => {
    await inOneWindow(60, BURST_MS);
    const statuses: number[] = [];
    for (let i = 0; i <= IP_LIMIT; i++) statuses.push((await post("/api/me/signout", "203.0.113.21")).status);
    expect(statuses.slice(0, IP_LIMIT).every((s) => s === 401)).toBe(true);
    expect(statuses[IP_LIMIT]).toBe(429);
  });

  it("AUTH-19 meter: GET /api/me spends the same per-IP meter before any read: 300 a minute, then 429", async () => {
    await inOneWindow(60, BURST_MS);
    const statuses: number[] = [];
    for (let i = 0; i <= IP_LIMIT; i++) {
      const res = await fetch(`${wrangler.url}/api/me`, { headers: { "CF-Connecting-IP": "203.0.113.22" } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, IP_LIMIT).every((s) => s === 200)).toBe(true);
    expect(statuses[IP_LIMIT]).toBe(429);
  });

  it("AUTH-16 admin: past the per-IP meter an admin path still answers the unknown path's 404", async () => {
    await inOneWindow(60, BURST_MS);
    for (let i = 1; i <= IP_LIMIT + 1; i++)
      expect((await post("/api/admin/view", "203.0.113.23")).status, `request ${i}`).toBe(404);
  });
});

// Member and admin rate limits with production timing: no TEST_TIMING, so the platform bindings are live.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inOneWindow } from "./open-client.ts";
import { PEPPER } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
/** RL_MEMBER_IP lowered for this server, so each burst crosses it in a few requests. */
const IP_LIMIT = 5;
/** A burst of IP_LIMIT + 2 local requests takes well under it. */
const WINDOW_MS = 1_000;
beforeAll(async () => {
  wrangler = await startWrangler({ HASH_PEPPER: PEPPER }, { migrate: true, limits: { RL_MEMBER_IP: IP_LIMIT } });
});
afterAll(() => wrangler?.stop());

const post = async (path: string, ip: string) => {
  const res = await fetch(`${wrangler.url}${path}`, {
    method: "POST",
    headers: { Origin: wrangler.url, "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: "{}",
  });
  return { status: res.status, body: await res.text() };
};

describe("AUTH-16 admin and the member limits, with real limits", () => {
  it("AUTH-19 meter: a member write spends the coarse per-IP guard: the limit, then 429, before any session read", async () => {
    await inOneWindow(60, WINDOW_MS);
    const statuses: number[] = [];
    for (let i = 0; i <= IP_LIMIT; i++) statuses.push((await post("/api/me/signout", "203.0.113.21")).status);
    expect(statuses.slice(0, IP_LIMIT).every((s) => s === 401)).toBe(true);
    expect(statuses[IP_LIMIT]).toBe(429);
  });

  it("AUTH-19 meter: GET /api/me spends the same per-IP meter before any read: the limit, then 429", async () => {
    await inOneWindow(60, WINDOW_MS);
    const statuses: number[] = [];
    for (let i = 0; i <= IP_LIMIT; i++) {
      const res = await fetch(`${wrangler.url}/api/me`, { headers: { "CF-Connecting-IP": "203.0.113.22" } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, IP_LIMIT).every((s) => s === 200)).toBe(true);
    expect(statuses[IP_LIMIT]).toBe(429);
  });

  it("AUTH-16 admin: a non-admin probe answers as an unknown /api/* path at every count, the refused meter included", async () => {
    await inOneWindow(60, WINDOW_MS);
    const unknown = await post("/api/no-such-path", "203.0.113.23");
    expect(unknown.status).toBe(404);
    for (let i = 1; i <= IP_LIMIT + 1; i++)
      expect(await post("/api/admin/view", "203.0.113.23"), `request ${i}`).toEqual(unknown);
    // The probe spent the shared meter: the same address's member write is now refused.
    expect((await post("/api/me/signout", "203.0.113.23")).status).toBe(429);
  });
});

// Member and admin rate limits with production timing: no TEST_TIMING, so the platform bindings are live.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inOneWindow } from "./open-client.ts";
import { PEPPER } from "./pairing-client.ts";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let wrangler: Wrangler;
beforeAll(async () => {
  wrangler = await startWrangler({ HASH_PEPPER: PEPPER }, { migrate: true });
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
  it("AUTH-16 admin: a non-admin probe of /api/admin/* answers as an unknown /api/* path at every one of 70 requests", async () => {
    for (let i = 1; i <= 70; i++) {
      const admin = await post("/api/admin/view", "203.0.113.20");
      const unknown = await post("/api/no-such-path", "203.0.113.20");
      expect(admin, `request ${i}`).toEqual(unknown);
      expect(admin.status).toBe(404);
    }
  });

  it("a member write spends the coarse per-IP guard: 60 a minute, then 429, before any session read", async () => {
    await inOneWindow();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await post("/api/me/signout", "203.0.113.21")).status);
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

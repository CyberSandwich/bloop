// The SpendGuard as a real Durable Object in workerd, behind a test-only Worker (test/fixtures/spend), so it runs
// before the main Worker binds it. Races here are real: concurrent requests reach one single-threaded object.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let w: Wrangler;
beforeAll(async () => {
  w = await startWrangler(
    { CAP_DEMO_SESSION_DAY: "5", CAP_EMAIL_RECIPIENT_DAY: "2" },
    { config: "test/fixtures/spend/wrangler.jsonc" },
  );
});
afterAll(() => w?.stop());

const rpc = async (method: string, ...args: unknown[]) => {
  const res = await fetch(`${w.url}/rpc/${method}`, { method: "POST", body: JSON.stringify(args) });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as any;
};

/** Runs a counter test again if a UTC day or hour rolled over under it: a counter test is exact only within one period. */
async function sameDay<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const before = new Date().toISOString().slice(0, 13);
    const out = await run();
    if (new Date().toISOString().slice(0, 13) === before || attempt >= 2) return out;
  }
}

describe("COST-14 COST-13 concurrent takes against the real object", () => {
  it("COST-13 200 concurrent exports for one user: exactly the 3 a day cap succeed", async () => {
    await sameDay(async () => {
      const user = `race-${crypto.randomUUID()}`;
      const out = await Promise.all(Array.from({ length: 200 }, () => rpc("take", "export_user", 1, user)));
      expect(out.filter((r) => r.ok)).toHaveLength(3);
      const refused = out.find((r) => !r.ok);
      expect(refused).toMatchObject({ reason: "cap_hit", meter: "export_user", scope: "own", period: "day" });
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    });
  });

  it("COST-14 the per-recipient cap (set to 2 by a var) holds under concurrency and other recipients are unaffected", async () => {
    await sameDay(async () => {
      const a = `r-${crypto.randomUUID()}`;
      const out = await Promise.all(Array.from({ length: 40 }, () => rpc("take", "email_recipient", 1, a)));
      expect(out.filter((r) => r.ok)).toHaveLength(2);
      expect((await rpc("take", "email_recipient", 1, `r-${crypto.randomUUID()}`)).ok).toBe(true);
    });
  });

  it("a scoped meter without a scope is rejected, not skipped", async () => {
    const res = await fetch(`${w.url}/rpc/take`, { method: "POST", body: JSON.stringify(["export_user", 1]) });
    expect(res.status).toBe(500);
  });
});

describe("COST-01 COST-02 leases against the real object", () => {
  it("COST-01 100 concurrent acquires of the account pool: exactly 3, and a release frees one", async () => {
    const out = await Promise.all(Array.from({ length: 100 }, () => rpc("acquire", "convert", 600, "u")));
    const held = out.filter((r) => r.ok);
    expect(held).toHaveLength(3);
    expect(out.find((r) => !r.ok)).toMatchObject({ reason: "busy" });
    expect(await rpc("release", held[0].leaseId)).toBe(true);
    expect((await rpc("acquire", "convert", 600, "u")).ok).toBe(true);
    expect((await rpc("snapshot")).pools.convert).toEqual({ live: 3, overdue: 0 });
  });

  it("COST-01 the guest and demo pool is separate and holds one", async () => {
    const out = await Promise.all(Array.from({ length: 20 }, () => rpc("acquire", "convert_public", 600)));
    expect(out.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("the client fails closed and the breaker latches over the real object", () => {
  it("COST-01 a call the guard throws on is a refusal through the client, not a pass", async () => {
    const res = await fetch(`${w.url}/client/take`, {
      method: "POST",
      body: JSON.stringify({ meter: "no_such_meter", n: 1 }),
    });
    expect(await res.json()).toMatchObject({ ok: false, reason: "unavailable", retryAfterSeconds: 30 });
    const good = await fetch(`${w.url}/client/take`, {
      method: "POST",
      body: JSON.stringify({ meter: "d1_writes", n: 1 }),
    });
    expect(await good.json()).toEqual({ ok: true });
  });

  it("COST-16 demo sessions past their cap trip demo=off once, alert once, and stay latched until reset", async () => {
    await sameDay(async () => {
      const before = (await rpc("snapshot")).counters.demo_session.day;
      for (let i = before; i < 5; i++) expect((await rpc("take", "demo_session", 1)).ok).toBe(true);
      expect((await rpc("take", "demo_session", 1)).ok).toBe(false);
      const run = async () => (await (await fetch(`${w.url}/breaker`, { method: "POST" })).json()) as any;
      const first = await run();
      expect(first.report.tripped).toEqual(["demo"]);
      expect(first.rows.demo).toBe("off");
      await run();
      const alerts = w
        .output()
        .split("\n")
        .filter((l) => l.includes('"evt":"breaker"') && l.includes('"kind":"trip"') && l.includes('"switch":"demo"'));
      expect(alerts).toHaveLength(1);
      expect(await rpc("resetTrip", "demo")).toBe(true);
      expect((await rpc("snapshot")).trips).toEqual([]);
    });
  });

  it("an override lowers a cap in the object at once and a bogus name is ignored", async () => {
    await sameDay(async () => {
      await rpc("setOverrides", { export_user_day: 1, not_a_cap: 0 });
      const user = `ov-${crypto.randomUUID()}`;
      expect((await rpc("take", "export_user", 1, user)).ok).toBe(true);
      expect((await rpc("take", "export_user", 1, user)).ok).toBe(false);
      await rpc("setOverrides", {});
      expect((await rpc("take", "export_user", 1, user)).ok).toBe(true);
    });
  });
});

// The SpendGuard as a real Durable Object in workerd, behind a test-only Worker (test/fixtures/spend), so it runs
// before the main Worker binds it. Races here are real: concurrent requests reach one single-threaded object.
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWrangler, type Wrangler } from "./wrangler.ts";

let w: Wrangler;
beforeAll(async () => {
  w = await startWrangler(
    { CAP_DEMO_SESSION_DAY: "5", CAP_EMAIL_CODE_IP_DAY: "2" },
    { config: "test/fixtures/spend/wrangler.jsonc" },
  );
});
afterAll(() => w?.stop());

/** `/rpc` reaches the global instance, `/rpc/public` the public one. */
const rpcTo =
  (prefix: string) =>
  async (method: string, ...args: unknown[]) => {
    const res = await fetch(`${w.url}${prefix}/${method}`, { method: "POST", body: JSON.stringify(args) });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as any;
  };
const rpc = rpcTo("/rpc");
const publicRpc = rpcTo("/rpc/public");

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

  it("COST-14 the per-IP code cap (set to 2 by a var) holds under concurrency and other IPs are unaffected", async () => {
    await sameDay(async () => {
      const a = `r-${crypto.randomUUID()}`;
      const out = await Promise.all(Array.from({ length: 40 }, () => rpc("take", "email_code", 1, a)));
      expect(out.filter((r) => r.ok)).toHaveLength(2);
      expect((await rpc("take", "email_code", 1, `r-${crypto.randomUUID()}`)).ok).toBe(true);
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
    expect((await rpc("snapshot")).pools.convert).toEqual({ live: 3 });
  });

  it("COST-01 the guest and demo pool is separate and holds one", async () => {
    const out = await Promise.all(Array.from({ length: 20 }, () => rpc("acquire", "convert_public", 600)));
    expect(out.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("the client fails closed and the breaker latches over the real object", () => {
  const clientTake = (body: object, query = "") =>
    fetch(`${w.url}/client/take${query}`, { method: "POST", body: JSON.stringify(body) });

  it("COST-01 an unreachable guard is a refusal through the client, not a pass; a caller bug is an error, not an outage", async () => {
    const down = await clientTake({ meter: "container_seconds", n: 1 }, "?down=1");
    expect(await down.json()).toMatchObject({ ok: false, reason: "unavailable", retryAfterSeconds: 30 });
    expect((await clientTake({ meter: "no_such_meter", n: 1 })).status).toBe(500);
    // A caller bug on a fail-open meter is not admitted as if the guard were down.
    expect((await clientTake({ meter: "email_code", n: 1 }, "?down=1")).status).toBe(500);
    const good = await clientTake({ meter: "container_seconds", n: 1 });
    expect(await good.json()).toMatchObject({ ok: true, ticket: { meter: "container_seconds", n: 1 } });
  });

  it("COST-16 the public meters count on their own instance, so a flood there never reaches the costly one", async () => {
    await sameDay(async () => {
      const before = {
        global: (await rpc("snapshot")).counters.demo_session.day,
        open: (await publicRpc("snapshot")).counters.demo_session.day,
      };
      expect(await (await clientTake({ meter: "demo_session", n: 1 })).json()).toMatchObject({ ok: true });
      expect((await rpc("snapshot")).counters.demo_session.day).toBe(before.global);
      expect((await publicRpc("snapshot")).counters.demo_session.day).toBe(before.open + 1);
      // A costly meter goes the other way.
      const user = `iso-${crypto.randomUUID()}`;
      await clientTake({ meter: "export_user", n: 1, scope: user });
      expect((await publicRpc("snapshot")).counters.export_user.day).toBe(0);
    });
  });

  it("the test Worker answers loopback hosts only", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const { hostname, port } = new URL(w.url);
      const req = request({ hostname, port, path: "/api/health", headers: { host: "bloop.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await fetch(`${w.url}/api/health`)).status).toBe(200);
  });

  it("COST-16 demo sessions past their cap trip demo=off once, alert once, and stay latched until reset", async () => {
    await sameDay(async () => {
      const before = (await publicRpc("snapshot")).counters.demo_session.day;
      for (let i = before; i < 5; i++) expect((await publicRpc("take", "demo_session", 1)).ok).toBe(true);
      expect((await publicRpc("take", "demo_session", 1)).ok).toBe(false);
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

  it("the object keeps daily history for the learning and stores the breaker's report for the admin route", async () => {
    await sameDay(async () => {
      const before = (await rpc("history", 32)).series.email[0];
      await rpc("record", "email", 3);
      const history = await rpc("history", 32);
      expect(history.series.email).toHaveLength(33);
      expect(history.series.email[0]).toBe(before + 3);
      expect(history.ageDays).toBe(0);
      const stored = JSON.parse(await rpc("report"));
      expect(stored.meters.map((m: { meter: string }) => m.meter)).toContain("container_seconds");
      expect(stored.adminUrl).toMatch(/\/admin$/);
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

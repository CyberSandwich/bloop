import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlLike } from "../../src/worker/do/demo-slots.ts";
import { METERS, type MeterDef, type MeterName, resolveCaps } from "../../src/worker/spend/caps.ts";
import { Ledger } from "../../src/worker/spend/meters.ts";
import { DAY, HOUR, rig, sqlOver, T0, transactionOver } from "./spend-helpers.ts";

/** The id a refundable take hands back. */
function takeId(
  ledger: Ledger,
  meter: MeterName,
  n: number,
  scope: string | undefined,
  caps: ReturnType<typeof resolveCaps>,
  now: number,
): string {
  const result = ledger.take(meter, n, scope, caps, now);
  if (!result.ok || !result.id) throw new Error("take gave no id");
  return result.id;
}

describe("counters: take is an exact check-and-add", () => {
  it("COST-14 email: 60 sends an hour, then refused with the wait until the hour ends, adding nothing", () => {
    const { ledger, caps } = rig();
    for (let i = 0; i < 60; i++) expect(ledger.take("email", 1, undefined, caps, T0).ok).toBe(true);
    const refused = ledger.take("email", 1, undefined, caps, T0 + 1000);
    expect(refused).toEqual({
      ok: false,
      reason: "cap_hit",
      meter: "email",
      period: "hour",
      scope: "all",
      retryAfterSeconds: 3599,
    });
    expect(ledger.snapshot(T0, caps).counters.email.hour).toBe(60);
  });

  it("COST-14 email: the day cap of 180 admits exactly 180 across hours and the next UTC day starts clean", () => {
    const { ledger, caps } = rig();
    expect(caps.email_day).toBe(180);
    let admitted = 0;
    // Six hours of 70 attempts each: the hour cap (60) and the day cap (180) both bind, and the attempts far exceed both.
    for (let h = 6; h >= 1; h--)
      for (let i = 0; i < 70; i++) if (ledger.take("email", 1, undefined, caps, T0 - h * HOUR).ok) admitted++;
    expect(admitted).toBe(180);
    expect(ledger.take("email", 1, undefined, caps, T0)).toMatchObject({ ok: false, period: "day" });
    expect(ledger.take("email", 1, undefined, caps, Date.UTC(2026, 10, 26, 0, 0, 0)).ok).toBe(true);
  });

  it("a take that would pass the cap by n is refused whole, and a smaller one still fits", () => {
    const { ledger, caps } = rig();
    expect(ledger.take("upload_user_bytes", 10 * 1024 ** 3 - 5, "u1", caps, T0).ok).toBe(true);
    expect(ledger.take("upload_user_bytes", 6, "u1", caps, T0).ok).toBe(false);
    expect(ledger.take("upload_user_bytes", 5, "u1", caps, T0).ok).toBe(true);
  });

  it("COST-11 uploads: the per-user cap is per scope, and the all-scopes count is the sum", () => {
    const { ledger, caps } = rig();
    for (let i = 0; i < 50; i++) expect(ledger.take("upload_user", 1, "u1", caps, T0).ok).toBe(true);
    expect(ledger.take("upload_user", 1, "u1", caps, T0)).toMatchObject({ ok: false, scope: "own", period: "day" });
    expect(ledger.take("upload_user", 1, "u2", caps, T0).ok).toBe(true);
    expect(ledger.snapshot(T0, caps).counters.upload_user.day).toBe(51);
  });

  it("COST-16 demo: 200 demo conversions a day all visitors, 10 per IP hash, refusal says which", () => {
    const { ledger, caps } = rig();
    for (let i = 0; i < 10; i++) ledger.take("convert_demo", 1, "ip1", caps, T0);
    expect(ledger.take("convert_demo", 1, "ip1", caps, T0)).toMatchObject({ ok: false, scope: "own" });
    for (let ip = 2; ip <= 20; ip++) for (let i = 0; i < 10; i++) ledger.take("convert_demo", 1, `ip${ip}`, caps, T0);
    expect(ledger.take("convert_demo", 1, "ip99", caps, T0)).toMatchObject({ ok: false, scope: "all" });
  });

  it("COST-16 demo: 2,000 demo sessions a day, global", () => {
    const { ledger, caps } = rig();
    expect(ledger.take("demo_session", 2000, undefined, caps, T0).ok).toBe(true);
    expect(ledger.take("demo_session", 1, undefined, caps, T0).ok).toBe(false);
  });

  it("COST-13 export: 3 a day per user", () => {
    const { ledger, caps } = rig();
    for (let i = 0; i < 3; i++) expect(ledger.take("export_user", 1, "u1", caps, T0).ok).toBe(true);
    expect(ledger.take("export_user", 1, "u1", caps, T0).ok).toBe(false);
    expect(ledger.take("export_user", 1, "u2", caps, T0).ok).toBe(true);
  });

  it("COST-07 R2: class A and B stop at the monthly cap and reset on the 1st", () => {
    const { ledger, caps } = rig({ CAP_R2_CLASS_A_MONTH: "10" });
    const small = resolveCaps({ CAP_R2_CLASS_A_MONTH: "10" });
    expect(ledger.take("r2_class_a", 10, undefined, small, T0).ok).toBe(true);
    expect(ledger.take("r2_class_a", 1, undefined, small, T0 + DAY)).toMatchObject({ ok: false, period: "month" });
    expect(ledger.take("r2_class_a", 1, undefined, small, Date.UTC(2026, 11, 1)).ok).toBe(true);
    expect(caps.r2_class_b_month).toBe(15_000_000);
  });

  it("a refused take writes nothing, so a flood of refusals costs no storage writes", () => {
    const { ledger, caps, db } = rig();
    ledger.take("demo_session", 2000, undefined, caps, T0);
    const before = db.prepare("SELECT sum(n) AS s, count(*) AS c FROM counter").get();
    for (let i = 0; i < 100; i++) ledger.take("demo_session", 1, undefined, caps, T0);
    expect(db.prepare("SELECT sum(n) AS s, count(*) AS c FROM counter").get()).toEqual(before);
  });

  it("a scoped meter without a scope throws instead of skipping the per-scope cap", () => {
    const { ledger, caps } = rig();
    expect(() => ledger.take("upload_user", 1, undefined, caps, T0)).toThrow(RangeError);
    expect(() => ledger.take("upload_user", 1, "", caps, T0)).toThrow(RangeError);
  });

  it("rejects n that is not a positive integer, and unknown meters", () => {
    const { ledger, caps } = rig();
    for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => ledger.take("email", n, undefined, caps, T0)).toThrow(RangeError);
    // @ts-expect-error a name outside the registry
    expect(() => ledger.take("nope", 1, undefined, caps, T0)).toThrow(RangeError);
  });

  // Every limit of every meter honors a lowered cap row, so none can be var-only by omission.
  const limits = Object.entries(METERS).flatMap(([meter, def]) =>
    [...((def as MeterDef).global ?? []), ...((def as MeterDef).perScope ?? [])].map((l) => [meter, l.cap] as const),
  );
  it.each(limits)("a cap row lowers %s through its %s limit", (meter, cap) => {
    const { ledger } = rig();
    const lowered = resolveCaps({}, { [cap]: 2 });
    const take = () => ledger.take(meter as MeterName, 1, "s", lowered, T0);
    expect([take().ok, take().ok, take().ok]).toEqual([true, true, false]);
  });

  it("a cap of 0 refuses everything, and a lowered override applies at once", () => {
    const { ledger } = rig();
    expect(ledger.take("email", 1, undefined, resolveCaps({ CAP_EMAIL_HOUR: "0" }), T0).ok).toBe(false);
    expect(ledger.take("email", 1, undefined, resolveCaps({}, { email_hour: 1 }), T0).ok).toBe(true);
    expect(ledger.take("email", 1, undefined, resolveCaps({}, { email_hour: 1 }), T0).ok).toBe(false);
  });

  it("the retry wait is the longest among the limits that refused", () => {
    const { ledger, caps } = rig({});
    for (let i = 0; i < 60; i++) ledger.take("email", 1, undefined, caps, T0);
    const tight = resolveCaps({}, { email_day: 60, email_hour: 60 });
    const refused = ledger.take("email", 1, undefined, tight, T0);
    expect(refused).toMatchObject({ ok: false, period: "day", retryAfterSeconds: 12 * 3600 });
  });

  it("record counts past a cap without refusing; refund gives back, floored at 0, on the day it was taken", () => {
    const { ledger, caps } = rig();
    const first = takeId(ledger, "container_seconds", 21_600, undefined, caps, T0);
    ledger.record("container_seconds", 5, undefined, T0);
    expect(ledger.snapshot(T0, caps).counters.container_seconds.day).toBe(21_605);
    ledger.refund(first, 30_000, T0, caps);
    expect(ledger.snapshot(T0, caps).counters.container_seconds.day).toBe(5);
    const late = Date.UTC(2026, 10, 25, 23, 59);
    const second = takeId(ledger, "container_seconds", 100, undefined, caps, late);
    ledger.refund(second, 40, late, caps);
    expect(ledger.snapshot(late, caps).counters.container_seconds.day).toBe(65);
    expect(ledger.snapshot(Date.UTC(2026, 10, 26, 0, 1), caps).counters.container_seconds.day).toBe(0);
  });

  it("COST-11 a refund is bounded by its own take and never erases another caller's counts", () => {
    const { ledger, caps } = rig();
    const u1 = takeId(ledger, "upload_user_bytes", 100, "u1", caps, T0);
    takeId(ledger, "upload_user_bytes", 100, "u2", caps, T0);
    expect(() => ledger.refund(u1, 0, T0, caps)).toThrow(RangeError);
    // u1 took 100 and asks for 150 back: u2's 100 stays in the all-scopes row.
    ledger.refund(u1, 150, T0, caps);
    expect(ledger.snapshot(T0, caps).counters.upload_user_bytes.day).toBe(100);
    expect(ledger.take("upload_user_bytes", caps.upload_user_bytes_day - 100, "u1", caps, T0).ok).toBe(true);
    // an id nobody minted changes nothing
    expect(ledger.refund("never-minted", 50, T0, caps)).toBe(false);
    expect(ledger.snapshot(T0, caps).counters.upload_user_bytes.day).toBe(caps.upload_user_bytes_day);
  });

  it("COST-14 only the refundable meters mint an id", () => {
    const { ledger, caps } = rig();
    expect(ledger.take("email", 1, undefined, caps, T0)).toEqual({ ok: true });
    expect(ledger.take("export_user", 1, "u1", caps, T0)).toEqual({ ok: true });
    for (const [meter, scope] of [
      ["container_seconds", undefined],
      ["upload_user", "u1"],
      ["upload_user_bytes", "u1"],
    ] as const) {
      expect(ledger.take(meter, 1, scope, caps, T0)).toEqual({ ok: true, id: expect.stringMatching(/^[\w-]{16}$/) });
    }
  });

  it("counters are exact across a Durable Object restart", () => {
    const r = rig();
    r.ledger.take("email", 7, undefined, r.caps, T0);
    expect(r.wake().snapshot(T0, r.caps).counters.email.day).toBe(7);
  });

  it("prune drops old hours, days and months and keeps current ones", () => {
    const { ledger, caps, db } = rig();
    ledger.take("email", 1, undefined, caps, T0 - 3 * DAY);
    ledger.take("email", 1, undefined, caps, T0 - 60 * DAY);
    ledger.take("email", 1, undefined, caps, T0);
    ledger.take("r2_class_a", 1, undefined, caps, T0 - 60 * DAY);
    ledger.take("r2_class_a", 1, undefined, caps, T0 - 500 * DAY);
    ledger.take("r2_class_a", 1, undefined, caps, T0);
    ledger.prune(T0, caps);
    const keys = (meter: string) =>
      (
        db.prepare("SELECT period FROM counter WHERE meter = ? AND scope = '' ORDER BY period").all(meter) as {
          period: string;
        }[]
      ).map((r) => r.period);
    expect(keys("email")).toEqual(["d2026-11-22", "d2026-11-25", "h2026-11-25T12"]);
    expect(keys("r2_class_a")).toEqual(["d2026-11-25", "m2026-09", "m2026-11"]);
  });
});

describe("COST-01 COST-12 concurrent callers: the ledger is synchronous, so a cap is exact", () => {
  it("methods return values, never promises, so no await can sit between check and act", () => {
    const { ledger, caps } = rig();
    for (const out of [
      ledger.take("email", 1, undefined, caps, T0),
      ledger.acquire("convert", undefined, 60, caps, T0),
      ledger.snapshot(T0, caps),
    ])
      expect(out).not.toBeInstanceOf(Promise);
  });

  it("COST-14 500 interleaved async callers against a cap of 60 get exactly 60", async () => {
    const { ledger, caps } = rig();
    const results = await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        await Promise.resolve();
        if (i % 3 === 0) await Promise.resolve();
        return ledger.take("email", 1, undefined, caps, T0);
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(60);
    expect(ledger.snapshot(T0, caps).counters.email.hour).toBe(60);
  });

  it("COST-01 100 interleaved acquires of the 3-slot pool get exactly 3", async () => {
    const { ledger, caps } = rig();
    const results = await Promise.all(
      Array.from({ length: 100 }, async () => {
        await Promise.resolve();
        return ledger.acquire("convert", "u", 60, caps, T0);
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });
});

describe("pools and leases", () => {
  it("COST-01 the account pool holds 3 and the public pool 1, independent of each other", () => {
    const { ledger, caps } = rig();
    expect([1, 2, 3].map(() => ledger.acquire("convert", "u", 600, caps, T0).ok)).toEqual([true, true, true]);
    expect(ledger.acquire("convert", "u", 600, caps, T0)).toMatchObject({ ok: false, reason: "busy" });
    expect(ledger.acquire("convert_public", undefined, 600, caps, T0).ok).toBe(true);
    expect(ledger.acquire("convert_public", undefined, 600, caps, T0).ok).toBe(false);
  });

  it("release frees the slot at once, and releasing twice or an unknown id is harmless", () => {
    const { ledger, caps } = rig();
    const a = ledger.acquire("convert_public", undefined, 600, caps, T0);
    if (!a.ok) throw new Error("expected a lease");
    expect(ledger.acquire("convert_public", undefined, 600, caps, T0).ok).toBe(false);
    expect(ledger.release(a.leaseId)).toBe(true);
    expect(ledger.release(a.leaseId)).toBe(false);
    expect(ledger.release("nope")).toBe(false);
    expect(ledger.acquire("convert_public", undefined, 600, caps, T0).ok).toBe(true);
  });

  it("COST-02 a lease's ttl is clamped to the pool maximum and gives the deadline", () => {
    const { ledger, caps } = rig();
    const a = ledger.acquire("convert", "u", 999_999, caps, T0);
    expect(a).toMatchObject({ ok: true, deadline: T0 + 1800 * 1000 });
    const e = ledger.acquire("export", "u1", 999_999, caps, T0);
    expect(e).toMatchObject({ ok: true, deadline: T0 + 900 * 1000 });
  });

  it("COST-02 a leaked lease keeps its slot through the deadline and grace, then is dropped and counted", () => {
    const { ledger, caps } = rig();
    ledger.acquire("convert_public", undefined, 60, caps, T0);
    const deadline = T0 + 60_000;
    expect(ledger.acquire("convert_public", undefined, 60, caps, deadline + 1).ok).toBe(false);
    expect(ledger.snapshot(deadline + 1, caps)).toMatchObject({
      pools: { convert_public: { live: 1 } },
      leasesDroppedToday: 0,
    });
    const after = deadline + 300_000;
    expect(ledger.acquire("convert_public", undefined, 60, caps, after).ok).toBe(true);
    expect(ledger.snapshot(after, caps).leasesDroppedToday).toBe(1);
  });

  it("COST-13 a pool with a per-scope cap throws without a scope instead of skipping the cap", () => {
    const { ledger, caps } = rig();
    expect(() => ledger.acquire("export", undefined, 60, caps, T0)).toThrow(RangeError);
    expect(() => ledger.acquire("export", "", 60, caps, T0)).toThrow(RangeError);
    // Pools with no per-scope cap take no scope.
    expect(ledger.acquire("convert_public", undefined, 60, caps, T0).ok).toBe(true);
  });

  it("every pool and lease cap honors a lowered row", () => {
    const { ledger } = rig();
    const one = resolveCaps(
      {},
      { pool_convert: 1, pool_convert_public: 0, pool_export: 1, lease_max_convert_seconds: 10 },
    );
    expect(ledger.acquire("convert", "u", 600, one, T0)).toMatchObject({ ok: true, deadline: T0 + 10_000 });
    expect(ledger.acquire("convert", "u", 600, one, T0).ok).toBe(false);
    expect(ledger.acquire("convert_public", undefined, 600, one, T0).ok).toBe(false);
    expect(ledger.acquire("export", "u1", 600, one, T0).ok).toBe(true);
    expect(ledger.acquire("export", "u2", 600, one, T0).ok).toBe(false);
    const other = rig();
    expect(other.ledger.acquire("export", "u3", 600, resolveCaps({}, { pool_export_per_scope: 0 }), T0).ok).toBe(false);
    const short = resolveCaps({}, { lease_max_export_seconds: 5 });
    expect(other.ledger.acquire("export", "u3", 600, short, T0)).toMatchObject({ ok: true, deadline: T0 + 5000 });
    // A lowered grace drops an unreleased lease sooner.
    const grace = resolveCaps({}, { lease_grace_seconds: 1 });
    const fresh = rig().ledger;
    expect(fresh.acquire("convert_public", undefined, 10, grace, T0).ok).toBe(true);
    expect(fresh.acquire("convert_public", undefined, 10, grace, T0 + 11_000).ok).toBe(true);
    expect(fresh.snapshot(T0 + 11_000, grace).leasesDroppedToday).toBe(1);
  });

  it("COST-13 export: one per user at once and 4 in all", () => {
    const { ledger, caps } = rig();
    expect(ledger.acquire("export", "u1", 60, caps, T0).ok).toBe(true);
    expect(ledger.acquire("export", "u1", 60, caps, T0).ok).toBe(false);
    for (const u of ["u2", "u3", "u4"]) expect(ledger.acquire("export", u, 60, caps, T0).ok).toBe(true);
    expect(ledger.acquire("export", "u5", 60, caps, T0).ok).toBe(false);
  });

  it("busy says when to try again, never more than 60 s", () => {
    const { ledger, caps } = rig();
    ledger.acquire("convert_public", undefined, 1800, caps, T0);
    expect(ledger.acquire("convert_public", undefined, 60, caps, T0 + 10_000)).toEqual({
      ok: false,
      reason: "busy",
      retryAfterSeconds: 60,
    });
    const short = rig();
    short.ledger.acquire("convert_public", undefined, 20, short.caps, T0);
    expect(short.ledger.acquire("convert_public", undefined, 60, short.caps, T0 + 10_000)).toMatchObject({
      retryAfterSeconds: 10,
    });
  });

  it("rejects a bad ttl and an unknown pool", () => {
    const { ledger, caps } = rig();
    for (const ttl of [0, -5, Number.NaN])
      expect(() => ledger.acquire("convert", "u", ttl, caps, T0)).toThrow(RangeError);
    // @ts-expect-error a name outside the registry
    expect(() => ledger.acquire("nope", "u", 60, caps, T0)).toThrow(RangeError);
  });

  it("leases survive a Durable Object restart", () => {
    const r = rig();
    for (let i = 0; i < 3; i++) r.ledger.acquire("convert", "u", 600, r.caps, T0);
    expect(r.wake().acquire("convert", "u", 600, r.caps, T0).ok).toBe(false);
  });
});

describe("latched breaker state", () => {
  it("latches once; the same or a looser value is not new; a stricter one replaces it and re-arms the alert", () => {
    const { ledger } = rig();
    expect(ledger.latchTrip("convert", "account_only", "r", "{}", T0)).toBe(true);
    ledger.markAlerted("convert", "account_only");
    expect(ledger.latchTrip("convert", "account_only", "r", "{}", T0)).toBe(false);
    expect(ledger.latchTrip("convert", "on", "r", "{}", T0)).toBe(false);
    expect(ledger.trips()[0]?.alerted).toBe(true);
    expect(ledger.latchTrip("convert", "off", "r2", "{}", T0 + 1)).toBe(true);
    expect(ledger.trips()).toMatchObject([{ switch: "convert", value: "off", reason: "r2", alerted: false }]);
  });

  it("markAlerted for an older value does not mark a newer trip", () => {
    const { ledger } = rig();
    ledger.latchTrip("convert", "account_only", "r", "{}", T0);
    ledger.latchTrip("convert", "off", "r", "{}", T0);
    ledger.markAlerted("convert", "account_only");
    expect(ledger.trips()[0]?.alerted).toBe(false);
  });

  it("stays latched across a restart until reset", () => {
    const r = rig();
    r.ledger.latchTrip("uploads", "readonly", "r", "{}", T0);
    expect(r.wake().trips()).toHaveLength(1);
    expect(r.ledger.resetTrip("uploads", T0, r.caps)).toBe(true);
    expect(r.ledger.resetTrip("uploads", T0, r.caps)).toBe(false);
    expect(r.wake().trips()).toHaveLength(0);
  });

  it("alertOnce is true once per key per UTC day", () => {
    const { ledger } = rig();
    expect(ledger.alertOnce("warn:x", T0)).toBe(true);
    expect(ledger.alertOnce("warn:x", T0 + HOUR)).toBe(false);
    expect(ledger.alertOnce("warn:y", T0)).toBe(true);
    expect(ledger.alertOnce("warn:x", T0 + DAY)).toBe(true);
  });

  it("unalertMany forgets every key it names and no other, past the 100 keys of one statement", () => {
    const { ledger } = rig();
    const keys = Array.from({ length: 150 }, (_, i) => `k${i}`);
    for (const key of [...keys, "kept"]) ledger.alertOnce(key, T0);
    ledger.unalertMany(keys);
    for (const key of keys) expect(ledger.alertOnce(key, T0), key).toBe(true);
    expect(ledger.alertOnce("kept", T0)).toBe(false);
  });

  it("overrides are replaced as a set and survive a restart", () => {
    const r = rig();
    r.ledger.setOverrides({ email_day: 10, convert_user_day: 5 });
    r.ledger.setOverrides({ email_day: 7, bad: Number.NaN });
    expect(r.wake().overrides()).toEqual({ email_day: 7 });
  });

  it("counts consecutive analytics failures and resets on a clean run", () => {
    const { ledger } = rig();
    expect([true, true, true].map((f) => ledger.analyticsRun(f))).toEqual([1, 2, 3]);
    expect(ledger.analyticsRun(false)).toBe(0);
    expect(ledger.analyticsRun(true)).toBe(1);
  });
});

describe("schema", () => {
  it("runs the numbered steps once and tolerates waking again and again", () => {
    const r = rig();
    r.wake();
    r.wake();
    expect(r.db.prepare("SELECT version FROM schema_version").all()).toEqual([{ version: 1 }]);
  });

  it("a half-applied wake leaves nothing behind and the next wake finishes the job", () => {
    const db = new DatabaseSync(":memory:");
    const real = sqlOver(db);
    let breakOnce = true;
    const flaky: SqlLike = {
      exec(query, ...bindings) {
        if (breakOnce && query.includes("CREATE TABLE IF NOT EXISTS blob")) {
          breakOnce = false;
          throw new Error("storage hiccup");
        }
        return real.exec(query, ...bindings);
      },
    };
    expect(() => new Ledger(flaky, () => T0, transactionOver(db))).toThrow("storage hiccup");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'counter'").all()).toEqual([]);
    const ledger = new Ledger(flaky, () => T0, transactionOver(db));
    expect(ledger.trips()).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_version").all()).toEqual([{ version: 1 }]);
  });

  it("COST-14 a refund past its window, or for more than was taken, does not go below zero or touch other days", () => {
    const { ledger, caps } = rig();
    ledger.record("container_seconds", 10, undefined, T0 - DAY);
    const id = takeId(ledger, "container_seconds", 5, undefined, caps, T0);
    const window =
      (Math.max(caps.lease_max_convert_seconds, caps.lease_max_export_seconds) + caps.lease_grace_seconds) * 1000;
    expect(ledger.refund(id, 3, T0 + window + 1, caps)).toBe(false);
    expect(ledger.snapshot(T0, caps).counters.container_seconds.day).toBe(5);
    expect(ledger.history(T0, 3).series.container_seconds[1]).toBe(10);
    expect(ledger.refund(id, 99, T0 + window, caps)).toBe(true);
    expect(ledger.snapshot(T0, caps).counters.container_seconds.day).toBe(0);
  });

  it("COST-14 a ticket id is honored once", () => {
    const { ledger, caps } = rig();
    const id = takeId(ledger, "container_seconds", 5, undefined, caps, T0);
    expect(ledger.refund(id, 2, T0, caps)).toBe(true);
    expect(ledger.refund(id, 2, T0, caps)).toBe(false);
    expect(ledger.snapshot(T0, caps).counters.container_seconds.day).toBe(3);
  });

  it("COST-14 take records are pruned a day after the longest refund window, computed from the lease vars", () => {
    const rows = (db: DatabaseSync) => db.prepare("SELECT count(*) AS n FROM taken").get();
    for (const vars of [{}, { CAP_LEASE_EXPORT_SECONDS: 7200, CAP_LEASE_GRACE_SECONDS: 600 }]) {
      const { ledger, caps, db } = rig(vars);
      const window =
        (Math.max(caps.lease_max_convert_seconds, caps.lease_max_export_seconds) + caps.lease_grace_seconds) * 1000;
      takeId(ledger, "container_seconds", 5, undefined, caps, T0);
      ledger.prune(T0 + window + DAY, caps);
      expect(rows(db)).toEqual({ n: 1 });
      ledger.prune(T0 + window + DAY + 1, caps);
      expect(rows(db)).toEqual({ n: 0 });
    }
  });

  it("COST-02 a reset takes the day's dropped leases as seen: only a drop after it trips again", () => {
    const { ledger, caps } = rig();
    const drop = (at: number) => {
      ledger.acquire("convert_public", undefined, 10, caps, at);
      return at + 10_000 + 300_000;
    };
    let now = drop(T0);
    expect(ledger.snapshot(now, caps)).toMatchObject({ leasesDroppedToday: 1, leasesDroppedSeen: 0 });
    ledger.latchTrip("convert", "off", "leases_overdue", "{}", now);
    ledger.resetTrip("convert", now, caps);
    expect(ledger.snapshot(now, caps)).toMatchObject({ leasesDroppedToday: 1, leasesDroppedSeen: 1 });
    now = drop(now);
    expect(ledger.snapshot(now, caps)).toMatchObject({ leasesDroppedToday: 2, leasesDroppedSeen: 1 });
  });
});

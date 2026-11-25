import { describe, expect, it } from "vitest";
import type { AnalyticsResult, Readings } from "../../src/worker/spend/analytics.ts";
import {
  type Alert,
  type BreakerDeps,
  type DigestMessage,
  evaluate,
  resetAllBreakers,
  resetBreaker,
  runBreaker,
} from "../../src/worker/spend/breaker.ts";
import { COSTLY_FLIPS, PRICED, PRICED_METERS, resolveCaps, resolveTrips } from "../../src/worker/spend/caps.ts";
import { buildReport, REPORT_DAYS, type SpendReport } from "../../src/worker/spend/report.ts";
import { effectiveSwitch, isStricter, SWITCHES } from "../../src/worker/spend/switches.ts";
import { DAY, fakeGuard, memoryStore, T0 } from "./spend-helpers.ts";

const MONDAY = Date.UTC(2026, 10, 30, 9);

function setup(vars: Record<string, unknown> = {}, analytics?: BreakerDeps["analytics"], start = T0, bornAt?: number) {
  const g = fakeGuard(vars, start, bornAt);
  const store = memoryStore();
  const sent: (Alert | DigestMessage)[] = [];
  const deps: BreakerDeps = {
    guard: g.guard,
    store,
    vars,
    now: () => g.clock.now,
    adminUrl: "https://bloop.example/admin",
    notify: async (m) => {
      sent.push(m);
    },
    ...(analytics ? { analytics } : {}),
  };
  const alerts = () => sent.filter((m): m is Alert => m.kind !== "digest");
  const digests = () => sent.filter((m): m is DigestMessage => m.kind === "digest");
  const snap = () => g.ledger.snapshot(g.clock.now, g.rig.caps);
  const report = (analyticsResult?: AnalyticsResult): SpendReport =>
    buildReport({
      now: g.clock.now,
      vars,
      history: g.ledger.history(g.clock.now, REPORT_DAYS),
      snapshot: snap(),
      ...(analyticsResult ? { analytics: analyticsResult } : {}),
      adminUrl: "https://bloop.example/admin",
      sources: "test",
    });
  const find = (readings?: Readings, analyticsResult?: AnalyticsResult) =>
    evaluate(snap(), readings, resolveTrips(vars), report(analyticsResult), { vars });
  return { g, store, sent, alerts, digests, deps, find, snap, report, run: () => runBreaker(deps) };
}

type Found = ReturnType<ReturnType<typeof setup>["find"]>;
const rules = (f: Found) => f.map((x) => `${x.level}:${x.rule}`);
const flipsOf = (f: Found) => f.flatMap((x) => (x.flips ?? []).map((y) => `${y.switch}=${y.value}`)).sort();

describe("COST-14 COST-16 daily trip lines: the $10 month split", () => {
  it("a quiet day finds nothing", () => {
    expect(setup().find()).toEqual([]);
  });

  it("email: warn at half the 95-send line, trip email=admin_only at 95", () => {
    const s = setup();
    s.g.ledger.record("email", 47, undefined, T0);
    expect(rules(s.find())).toEqual([]);
    s.g.ledger.record("email", 1, undefined, T0);
    expect(rules(s.find())).toEqual(["warn:email_day_warn"]);
    s.g.ledger.record("email", 47, undefined, T0);
    expect(s.find()).toMatchObject([
      { level: "trip", rule: "email_day", flips: [{ switch: "email", value: "admin_only" }] },
    ]);
  });

  it("each priced meter trips its own switch at its floor", () => {
    const at = (meter: "container_seconds" | "r2_class_a" | "r2_class_b" | "d1_writes", n: number) => {
      const s = setup();
      s.g.ledger.record(meter, n, undefined, T0);
      return flipsOf(s.find());
    };
    expect(at("container_seconds", 4190)).toEqual(["convert=off"]);
    expect(at("r2_class_a", 11_111)).toEqual(["uploads=readonly"]);
    expect(at("r2_class_b", 46_296)).toEqual(["previews=off"]);
    expect(at("d1_writes", 33_333)).toEqual(["demo=off"]);
    expect(at("container_seconds", 4189)).toEqual([]);
  });

  it("the line adapts to the history: 14 days at 50 sends put it at 150, so 100 only warns and 150 trips", () => {
    const s = setup();
    for (let i = 1; i <= 14; i++) s.g.ledger.record("email", 50, undefined, T0 - i * DAY);
    s.g.ledger.record("email", 100, undefined, T0);
    expect(rules(s.find())).toEqual(["warn:email_day_warn"]);
    s.g.ledger.record("email", 50, undefined, T0);
    expect(rules(s.find())).toEqual(["trip:email_day"]);
  });

  it("a young guard trips at the floor: 3 days of busy history do not raise the line", () => {
    const s = setup({}, undefined, T0, T0 - 3 * DAY);
    for (let i = 1; i <= 3; i++) s.g.ledger.record("email", 300, undefined, T0 - i * DAY);
    s.g.ledger.record("email", 95, undefined, T0);
    expect(rules(s.find())).toEqual(["trip:email_day"]);
  });

  it("analytics sees a presigned-PUT flood the Worker never counted and trips uploads=readonly", () => {
    const s = setup();
    const analytics: AnalyticsResult = { daily: { r2ClassA: { "2026-11-25": 400_000 } }, failed: [] };
    expect(flipsOf(s.find(undefined, analytics))).toEqual(["uploads=readonly"]);
  });

  it("a var moves a line: a lower floor trips sooner", () => {
    const s = setup({ BREAKER_FLOOR_EMAIL: "10" });
    s.g.ledger.record("email", 10, undefined, T0);
    expect(rules(s.find())).toEqual(["trip:email_day"]);
  });
});

describe("the month-to-date stop", () => {
  const spend = (s: ReturnType<typeof setup>, seconds: number) => {
    for (const i of [5, 4, 3]) s.g.ledger.record("container_seconds", Math.ceil(seconds / 3), undefined, T0 - i * DAY);
  };

  it("at $8 (80 percent of $10) it warns, and at $10 it flips every costly switch in one finding", () => {
    const warn = setup();
    spend(warn, 225_000);
    expect(rules(warn.find())).toEqual(["warn:month_budget_warn"]);
    const stop = setup();
    spend(stop, 280_000);
    const f = stop.find();
    expect(rules(f)).toEqual(["trip:month_budget"]);
    expect(f[0]?.flips).toEqual([...COSTLY_FLIPS]);
    expect(flipsOf(f)).toEqual(
      [
        "convert=off",
        "demo_drop=off",
        "email=admin_only",
        "export=off",
        "guest_drop=off",
        "previews=off",
        "uploads=readonly",
      ].sort(),
    );
  });

  it("the budget is a var: raising it to $25 holds the stop", () => {
    const s = setup({ BREAKER_BUDGET_MONTH_USD: "25" });
    spend(s, 280_000);
    expect(rules(s.find())).toEqual([]);
  });

  it("one trip, one alert: seven rows flip, the owner gets a single message listing them, latched until reset", async () => {
    const s = setup();
    spend(s, 280_000);
    const run = await s.run();
    expect(run.tripped).toHaveLength(7);
    expect([...s.store.rows.entries()].sort()).toEqual(
      [
        ["convert", "off"],
        ["demo_drop", "off"],
        ["email", "admin_only"],
        ["export", "off"],
        ["guest_drop", "off"],
        ["previews", "off"],
        ["uploads", "readonly"],
      ].sort(),
    );
    const trips = s.alerts().filter((a) => a.kind === "trip");
    expect(trips).toHaveLength(1);
    expect(trips[0]?.flips).toHaveLength(7);
    expect(trips[0]?.rule).toBe("month_budget");
    await s.run();
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(1);
    expect(s.store.writes.every((w) => w.actor === "breaker")).toBe(true);
  });

  it("resetting everything clears the latches; while the month is still over budget the next run trips again", async () => {
    const s = setup();
    spend(s, 280_000);
    await s.run();
    expect(await resetAllBreakers(s.deps, "admin")).toHaveLength(7);
    expect(s.g.ledger.trips()).toEqual([]);
    expect(s.store.rows.get("convert")).toBe("account_only");
    s.g.clock.now += 1000;
    await s.run();
    expect(s.g.ledger.trips()).toHaveLength(7);
  });
});

describe("rules that stay count-based", () => {
  it("demo conversions at 200 trip demo_drop=off; demo sessions at 2,000 trip demo=off", () => {
    const s = setup();
    s.g.ledger.record("convert_demo", 200, undefined, T0);
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    expect(flipsOf(s.find())).toEqual(["demo=off", "demo_drop=off"]);
  });

  it("R2 monthly meters warn at 80 percent of the cap", () => {
    const s = setup();
    s.g.ledger.record("r2_class_a", 1_200_000, undefined, T0);
    expect(rules(s.find())).toContain("warn:r2_class_a_month");
  });

  it("guest drops: 5% of the budget a day (833) trips demo_drop=off, 15% (2,500) trips guest_files=stopped", () => {
    const s = setup();
    s.g.ledger.record("guest_drop", 832, "ip", T0);
    expect(s.find()).toEqual([]);
    s.g.ledger.record("guest_drop", 1, "ip", T0);
    expect(flipsOf(s.find())).toEqual(["demo_drop=off"]);
    s.g.ledger.record("guest_drop", 1667, "ip", T0);
    expect(flipsOf(s.find())).toEqual(["demo_drop=off", "guest_files=stopped"]);
  });

  it("COST-02 a conversion lease over the pool total, or one that outlived its deadline, trips convert=off", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.g.ledger.acquire("convert", "u", 600, s.g.rig.caps, T0);
    s.g.ledger.acquire("convert_public", undefined, 600, s.g.rig.caps, T0);
    expect(s.find()).toEqual([]);
    const leak = setup();
    leak.g.ledger.acquire("convert", "u", 60, leak.g.rig.caps, T0);
    // One second past the deadline the Converter is still destroying the container: no trip. Past the grace, trip.
    leak.g.clock.now = T0 + 61_000;
    expect(leak.find()).toEqual([]);
    leak.g.clock.now = T0 + 60_000 + 299_000;
    expect(leak.find()).toEqual([]);
    leak.g.clock.now = T0 + 60_000 + 300_000;
    expect(leak.find()).toMatchObject([
      { level: "trip", rule: "leases_overdue", flips: [{ switch: "convert", value: "off" }] },
    ]);
  });

  it("COST-02 a lease released a second after its deadline never latches convert off, end to end", async () => {
    const s = setup();
    const lease = s.g.ledger.acquire("convert", "u", 60, s.g.rig.caps, T0);
    if (!lease.ok) throw new Error("expected a lease");
    s.g.clock.now = T0 + 61_000;
    await s.run();
    s.g.ledger.release(lease.leaseId);
    await s.run();
    expect(s.g.ledger.trips()).toEqual([]);
    expect(s.store.rows.has("convert")).toBe(false);
  });

  it("COST-02 after a reset the day's old drops do not trip again; a new drop does", async () => {
    const s = setup();
    const caps = s.g.rig.caps;
    s.g.ledger.acquire("convert_public", undefined, 10, caps, T0);
    s.g.clock.now = T0 + 10_000 + 300_000;
    await s.run();
    expect(s.g.ledger.trips()).toMatchObject([{ switch: "convert", value: "off", reason: "leases_overdue" }]);
    expect(await resetBreaker(s.deps, "convert", "admin")).toBe(true);
    await s.run();
    expect(s.g.ledger.trips()).toEqual([]);
    s.g.ledger.acquire("convert_public", undefined, 10, caps, s.g.clock.now);
    s.g.clock.now += 10_000 + 300_000;
    await s.run();
    expect(s.g.ledger.trips()).toMatchObject([{ switch: "convert", reason: "leases_overdue" }]);
  });

  it("COST-02 lowering a pool with leases still running is no leak: the line is the pools as the vars set them", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.g.ledger.acquire("convert", "u", 600, s.g.rig.caps, T0);
    s.g.ledger.acquire("convert_public", undefined, 600, s.g.rig.caps, T0);
    // A cap.pool_convert row of 1 reaches the snapshot's caps, with 2 more live than it now allows.
    const lowered = { ...s.snap(), caps: resolveCaps({}, { pool_convert: 1 }) };
    expect(evaluate(lowered, undefined, resolveTrips({}), s.report(), { vars: {} })).toEqual([]);
    // Past the vars' own pools it still trips.
    s.g.ledger.acquire("convert", "u", 600, resolveCaps({ CAP_POOL_CONVERT: "9" }), T0);
    expect(rules(evaluate(s.snap(), undefined, resolveTrips({}), s.report(), { vars: {} }))).toEqual([
      "trip:leases_live",
    ]);
  });

  it("COST-02 the live-lease line follows the pool caps, so raising a pool does not trip it", () => {
    const s = setup({ CAP_POOL_CONVERT: "6" });
    for (let i = 0; i < 6; i++) s.g.ledger.acquire("convert", "u", 600, s.g.rig.caps, T0);
    s.g.ledger.acquire("convert_public", undefined, 600, s.g.rig.caps, T0);
    expect(s.find()).toEqual([]);
  });

  it("COST-03 failed conversions trip convert=account_only only past 20 percent of at least 10", () => {
    const s = setup();
    s.g.ledger.record("conversion_failed", 9, undefined, T0);
    expect(s.find()).toEqual([]);
    s.g.ledger.record("conversion_done", 1, undefined, T0);
    expect(rules(s.find())).toEqual(["trip:convert_failed"]);
    const ok = setup();
    ok.g.ledger.record("conversion_done", 80, undefined, T0);
    ok.g.ledger.record("conversion_failed", 20, undefined, T0);
    expect(ok.find()).toEqual([]);
  });

  it("platform lines warn and never flip: Workers 1M a day, 3x the 7-day mean over a 50,000 floor, DO", () => {
    const s = setup();
    const w = (r: Readings) => rules(s.find(r));
    expect(w({ workersRequests: 1_000_000 })).toEqual(["warn:workers_requests"]);
    expect(w({ workersRequests: 400_000, workersRequests7dMean: 100_000 })).toEqual(["warn:workers_spike"]);
    expect(w({ workersRequests: 40_000, workersRequests7dMean: 100 })).toEqual([]);
    expect(w({ doRequests: 150_000 })).toEqual(["warn:do_requests"]);
    expect(w({ doGbSeconds: 30_000 })).toEqual(["warn:do_duration"]);
    expect(s.find({ workersRequests: 9e9, doRequests: 9e9 }).every((f) => !f.flips)).toBe(true);
  });

  it("R2 storage past its share of the budget warns", () => {
    const s = setup();
    const analytics: AnalyticsResult = { daily: {}, r2StorageBytes: 34e9, failed: [] };
    expect(rules(s.find(undefined, analytics))).toContain("warn:r2_storage_bytes_warn");
  });
});

describe("runBreaker: flip, latch, alert once", () => {
  it("COST-16 a trip writes the row as breaker, latches, sends one alert, and a second run does neither", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    const first = await s.run();
    expect(first.tripped).toEqual(["demo"]);
    expect(s.store.writes).toEqual([{ name: "demo", value: "off", actor: "breaker", reason: "demo_session_cap" }]);
    expect(s.alerts()).toMatchObject([{ kind: "trip", switch: "demo", value: "off", rule: "demo_session_cap" }]);
    await s.run();
    await s.run();
    expect(s.store.writes).toHaveLength(1);
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(1);
  });

  it("the latch outlasts the daily counter: at 00:00 UTC the counter resets and the row stays flipped", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    s.g.clock.now = T0 + DAY;
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
    expect(s.g.ledger.trips()).toHaveLength(1);
  });

  it("COST-02 a trip changes what is in force: from the default rows, every convert trip writes convert=off", async () => {
    const cases: [string, (s: ReturnType<typeof setup>) => void][] = [
      ["containers line", (s) => s.g.ledger.record("container_seconds", 4190, undefined, T0)],
      [
        "failed conversions",
        (s) => {
          s.g.ledger.record("conversion_failed", 8, undefined, T0);
          s.g.ledger.record("conversion_done", 4, undefined, T0);
        },
      ],
    ];
    for (const [, trip] of cases) {
      const s = setup();
      expect(effectiveSwitch("convert", undefined, s.store.rows.get("convert"))).toBe("account_only");
      trip(s);
      await s.run();
      expect(s.store.rows.get("convert")).toBe("off");
      expect(effectiveSwitch("convert", undefined, s.store.rows.get("convert"))).toBe("off");
    }
  });

  it("every flip the breaker can make is stricter than its switch's default", () => {
    const flips = [...PRICED_METERS.map((m) => PRICED[m].flip), ...COSTLY_FLIPS];
    for (const f of flips) expect(isStricter(f.switch, f.value, SWITCHES[f.switch].default)).toBe(true);
  });

  it("a second rule on the same switch and value is not a new trip or a new alert", async () => {
    const s = setup();
    s.g.ledger.record("container_seconds", 4190, undefined, T0);
    await s.run();
    s.g.ledger.acquire("convert", "u", 60, s.g.rig.caps, T0);
    s.g.clock.now = T0 + 400_000;
    await s.run();
    expect(s.store.rows.get("convert")).toBe("off");
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(1);
  });

  it("a trip never loosens a row the owner or the var already made stricter", async () => {
    const s = setup();
    s.store.rows.set("convert", "off");
    s.g.ledger.record("container_seconds", 4190, undefined, T0);
    await s.run();
    expect(s.store.rows.get("convert")).toBe("off");
    expect(s.store.writes).toHaveLength(0);
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(1);
  });

  it("a failed row write is announced as not applied, retried next run, and announced as applied once it lands", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    s.store.failNextSet = true;
    await s.run();
    expect(s.store.rows.has("demo")).toBe(false);
    expect(s.alerts().filter((a) => a.kind === "trip")).toMatchObject([{ switch: "demo", applied: false }]);
    expect(s.g.ledger.trips()).toMatchObject([{ alerted: false }]);
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
    const trips = s.alerts().filter((a) => a.kind === "trip");
    expect(trips).toHaveLength(2);
    expect(trips[1]).not.toHaveProperty("applied");
    expect(s.g.ledger.trips()).toMatchObject([{ alerted: true }]);
    await s.run();
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(2);
  });

  it("a reset that lands between the run's read and its write is not undone", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    const read = s.store.get;
    let fired = false;
    s.store.get = async (name) => {
      const value = await read(name);
      // Once the trip is latched, the owner resets it before the run writes the row.
      if (name === "demo" && !fired && s.g.ledger.trips().length > 0) {
        fired = true;
        s.g.ledger.resetTrip("demo", s.g.clock.now, s.g.rig.caps);
      }
      return value;
    };
    await s.run();
    expect(fired).toBe(true);
    expect(s.store.rows.has("demo")).toBe(false);
    expect(s.g.ledger.trips()).toEqual([]);
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(0);
  });

  it("a reset fired while the run still holds an older snapshot refuses that run's latch, and a later run latches", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    const read = s.store.get;
    let fired = false;
    s.store.get = async (name) => {
      const value = await read(name);
      // The snapshot is already taken; the owner resets before the run's first latch.
      if (name === "breaker" && !fired) {
        fired = true;
        s.g.ledger.resetTrip("demo", s.g.clock.now, s.g.rig.caps);
      }
      return value;
    };
    await s.run();
    expect(fired).toBe(true);
    expect(s.g.ledger.trips()).toEqual([]);
    expect(s.store.rows.has("demo")).toBe(false);
    s.g.clock.now += 1000;
    await s.run();
    expect(s.g.ledger.trips()).toMatchObject([{ switch: "demo", value: "off" }]);
  });

  it("a failed alert is retried next run and the row is written once", async () => {
    const s = setup();
    let down = true;
    s.deps.notify = async (m) => {
      if (down) throw new Error("mail down");
      s.sent.push(m);
    };
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await runBreaker(s.deps);
    down = false;
    await runBreaker(s.deps);
    await runBreaker(s.deps);
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(1);
    expect(s.store.writes).toHaveLength(1);
  });

  it("an owner flipping the row back without a reset is flipped again: only a reset releases the latch", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    s.store.rows.set("demo", "on");
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
  });

  it("reset clears the latch, returns the switch to its default, logs it, and a new trip can then fire", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    expect(await resetBreaker(s.deps, "demo", "admin")).toBe(true);
    expect(s.store.rows.get("demo")).toBe("on");
    expect(s.store.writes.at(-1)).toMatchObject({ actor: "admin" });
    expect(s.alerts().at(-1)).toMatchObject({ kind: "reset", switch: "demo" });
    s.g.clock.now = T0 + DAY;
    expect(await s.run()).toMatchObject({ tripped: [] });
  });

  it("a reset leaves a row the owner set to the breaker's own value, because the breaker did not write it", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    // The owner sets the same value by hand: the row's writer is no longer the breaker.
    s.store.rows.set("demo", "off");
    s.store.actors.set("demo", "owner");
    expect(await resetBreaker(s.deps, "demo", "admin")).toBe(true);
    expect(s.store.rows.get("demo")).toBe("off");
    expect(s.alerts().at(-1)).toMatchObject({ kind: "reset", value: "unchanged" });
    expect(s.g.ledger.trips()).toEqual([]);
  });

  it("COST-16 the public meters are read from the public instance, and a global one's counts for them are ignored", async () => {
    const s = setup();
    const open = fakeGuard();
    s.deps.publicGuard = open.guard;
    s.g.ledger.record("email", 95, undefined, T0);
    await s.run();
    expect(s.g.ledger.trips()).toEqual([]);
    open.ledger.record("email", 95, undefined, T0);
    open.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    expect(
      s.g.ledger
        .trips()
        .map((t) => `${t.switch}=${t.value}`)
        .sort(),
    ).toEqual(["demo=off", "email=admin_only"]);
  });

  it("COST-16 a public instance that cannot be read does not stop the run or the costly rules", async () => {
    const s = setup();
    const open = fakeGuard();
    open.guard.snapshot = async () => {
      throw new Error("public guard down");
    };
    s.deps.publicGuard = open.guard;
    s.g.ledger.record("container_seconds", 4190, undefined, T0);
    await expect(s.run()).resolves.toMatchObject({ tripped: ["convert"] });
  });

  it("COST-16 an unreadable public instance is said so, once, and its meters are skipped, not read as zero", async () => {
    const s = setup();
    const open = fakeGuard();
    open.guard.snapshot = async () => {
      throw new Error("public guard down");
    };
    s.deps.publicGuard = open.guard;
    // Counted on the global instance by mistake, a number that would trip email at once if it were evaluated.
    s.g.ledger.record("email", 95, undefined, T0);
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    await s.run();
    expect(s.g.ledger.trips()).toEqual([]);
    const down = s.alerts().filter((a) => a.rule === "public_guard_unreadable");
    expect(down).toHaveLength(1);
    expect(down[0]).toMatchObject({ kind: "public_unreadable" });
    expect(down[0]?.sources).toContain("public guard unreadable");
    const stored = JSON.parse((await s.deps.guard.report()) ?? "null") as SpendReport;
    expect(stored.sources).toContain("public guard unreadable");
  });

  it("breaker=alert_only: no latch and no row write, a would_trip alert once a day", async () => {
    const s = setup({ SWITCH_BREAKER: "alert_only" });
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    await s.run();
    expect(s.store.writes).toHaveLength(0);
    expect(s.g.ledger.trips()).toHaveLength(0);
    expect(s.alerts()).toMatchObject([{ kind: "would_trip", switch: "demo", value: "off" }]);
  });

  it("breaker=alert_only set as a row also stops flips", async () => {
    const s = setup();
    s.store.rows.set("breaker", "alert_only");
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    expect(s.store.writes).toHaveLength(0);
  });

  it("warnings go out once per rule per UTC day", async () => {
    const s = setup();
    s.g.ledger.record("email", 50, undefined, T0);
    await s.run();
    await s.run();
    expect(s.alerts().filter((a) => a.kind === "warn")).toHaveLength(1);
    s.g.clock.now = T0 + DAY;
    // Yesterday's 50 lifted the line to 150 (the p95 of history is 50), so warning needs 75.
    s.g.ledger.record("email", 80, undefined, s.g.clock.now);
    await s.run();
    expect(s.alerts().filter((a) => a.kind === "warn")).toHaveLength(2);
  });

  it("D1 down for reads and writes: the trip latches and the owner is told, marked not applied, never alerted as applied", async () => {
    const s = setup();
    s.store.get = async () => {
      throw new Error("d1 down");
    };
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await expect(s.run()).resolves.toMatchObject({ tripped: ["demo"] });
    expect(s.g.ledger.trips()).toMatchObject([{ switch: "demo", alerted: false }]);
    expect(s.alerts().filter((a) => a.kind === "trip")).toMatchObject([
      { switch: "demo", value: "off", applied: false },
    ]);
  });

  it("an alert carries numbers only", async () => {
    const s = setup();
    s.g.ledger.record("email", 95, undefined, T0);
    await s.run();
    for (const a of s.alerts()) for (const v of Object.values(a.readings)) expect(typeof v).toBe("number");
  });

  it("each run stores the report the admin panel and route read back", async () => {
    const s = setup();
    s.g.ledger.record("email", 12, undefined, T0);
    await s.run();
    const stored = JSON.parse((await s.deps.guard.report()) ?? "null") as SpendReport;
    expect(stored.meters.find((m) => m.meter === "email")?.today).toBe(12);
    expect(stored.adminUrl).toBe("https://bloop.example/admin");
  });
});

describe("the Monday digest", () => {
  it("is sent once on a Monday however often the cron runs, with the next review and the admin link last", async () => {
    const s = setup({}, undefined, MONDAY);
    expect((await s.run()).digestSent).toBe(true);
    expect((await s.run()).digestSent).toBe(false);
    await s.run();
    expect(s.digests()).toHaveLength(1);
    const text = s.digests()[0]?.text.trimEnd().split("\n") ?? [];
    expect(text.at(-2)).toMatch(/^Next monthly review: 2026-12-07/);
    expect(text.at(-1)).toBe("Admin: https://bloop.example/admin");
    expect(s.digests()[0]?.subject).toBe("bloop spend digest 2026-W49");
  });

  it("is not sent on any other day, and comes again the next Monday", async () => {
    const s = setup();
    expect((await s.run()).digestSent).toBe(false);
    s.g.clock.now = MONDAY + DAY;
    expect((await s.run()).digestSent).toBe(false);
    s.g.clock.now = MONDAY + 7 * DAY;
    expect((await s.run()).digestSent).toBe(true);
    expect(s.digests()).toHaveLength(1);
  });

  it("a failed send is tried again on the next run", async () => {
    const s = setup({}, undefined, MONDAY);
    let down = true;
    s.deps.notify = async (m) => {
      if (down) throw new Error("mail down");
      s.sent.push(m);
    };
    expect((await runBreaker(s.deps)).digestSent).toBe(false);
    down = false;
    expect((await runBreaker(s.deps)).digestSent).toBe(true);
    expect(s.digests()).toHaveLength(1);
  });
});

describe("runBreaker: sources", () => {
  it("without an analytics token every alert says it saw counters only", async () => {
    const s = setup();
    s.g.ledger.record("email", 95, undefined, T0);
    const report = await s.run();
    expect(report.sources).toBe("counters only (no CF_ANALYTICS_TOKEN)");
    expect(s.alerts().every((a) => a.sources.startsWith("counters only"))).toBe(true);
  });

  it("with analytics, a presigned-PUT flood the Worker never counted trips uploads=readonly", async () => {
    const s = setup({}, async () => ({ daily: { r2ClassA: { "2026-11-25": 400_000 } }, failed: [] }));
    const report = await s.run();
    expect(report.sources).toBe("counters plus analytics");
    expect(s.store.rows.get("uploads")).toBe("readonly");
  });

  it("three runs in a row with a failed dataset send one analytics_down alert, then no more until a clean run", async () => {
    const s = setup({}, async () => ({ daily: {}, failed: [{ dataset: "d1", error: "bad field" }] }));
    const report = await s.run();
    expect(report.sources).toBe("counters plus analytics (failed: d1; last good figures held)");
    await s.run();
    expect(s.alerts().filter((a) => a.kind === "analytics_down")).toHaveLength(0);
    await s.run();
    await s.run();
    await s.run();
    expect(s.alerts().filter((a) => a.kind === "analytics_down")).toHaveLength(1);
  });

  it("the counters still trip while analytics is down", async () => {
    const s = setup({}, async () => ({ daily: {}, failed: [{ dataset: "workers", error: "x" }] }));
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
  });
});

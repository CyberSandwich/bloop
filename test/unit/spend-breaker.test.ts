import { describe, expect, it } from "vitest";
import { type Alert, type BreakerDeps, evaluate, resetBreaker, runBreaker } from "../../src/worker/spend/breaker.ts";
import { resolveTrips } from "../../src/worker/spend/caps.ts";
import { DAY, fakeGuard, memoryStore, T0 } from "./spend-helpers.ts";

const trips = resolveTrips({});

function setup(vars: Record<string, unknown> = {}, analytics?: BreakerDeps["analytics"]) {
  const g = fakeGuard(vars);
  const store = memoryStore();
  const alerts: Alert[] = [];
  const deps: BreakerDeps = {
    guard: g.guard,
    store,
    vars,
    now: () => g.clock.now,
    notify: async (a) => {
      alerts.push(a);
    },
    ...(analytics ? { analytics } : {}),
  };
  const snap = () => g.ledger.snapshot(g.clock.now, g.rig.caps);
  return { g, store, alerts, deps, snap, run: () => runBreaker(deps) };
}

const rules = (f: ReturnType<typeof evaluate>) => f.map((x) => `${x.level}:${x.rule}`);

describe("COST-14 COST-16 breaker rules: each trip line is pinned", () => {
  it("a quiet day finds nothing", () => {
    const s = setup();
    expect(evaluate(s.snap(), undefined, trips)).toEqual([]);
  });

  it("container seconds: warn at 50 percent of the 21,600 daily budget, trip convert=account_only at 100", () => {
    const s = setup();
    s.g.ledger.take("container_seconds", 10_800, undefined, s.g.rig.caps, T0);
    expect(rules(evaluate(s.snap(), undefined, trips))).toEqual(["warn:container_seconds_warn"]);
    s.g.ledger.take("container_seconds", 10_800, undefined, s.g.rig.caps, T0);
    const [f] = evaluate(s.snap(), undefined, trips);
    expect(f).toMatchObject({ level: "trip", flip: { switch: "convert", value: "account_only" } });
  });

  it("demo conversions at 200 trip demo_drop=off; demo sessions at 2,000 trip demo=off; email at 300 trips email=admin_only", () => {
    const s = setup();
    const c = s.g.rig.caps;
    s.g.ledger.record("convert_demo", 200, undefined, T0);
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    s.g.ledger.record("email", 300, undefined, T0);
    const flips = evaluate(s.snap(), undefined, trips).flatMap((f) =>
      f.flip ? [`${f.flip.switch}=${f.flip.value}`] : [],
    );
    expect(flips.sort()).toEqual(["demo=off", "demo_drop=off", "email=admin_only"]);
    expect(c.email_day).toBe(300);
  });

  it("email warns at 150, half of the day cap", () => {
    const s = setup();
    s.g.ledger.record("email", 150, undefined, T0);
    expect(rules(evaluate(s.snap(), undefined, trips))).toEqual(["warn:email_warn"]);
  });

  it("R2 class A: monthly warn at 80 percent; daily warn at 50,000 and trip uploads=readonly at 250,000, from the counter or analytics", () => {
    const s = setup();
    s.g.ledger.record("r2_class_a", 1_200_000, undefined, T0);
    expect(rules(evaluate(s.snap(), undefined, trips))).toContain("warn:r2_class_a_month");
    const quiet = setup();
    expect(rules(evaluate(quiet.snap(), { r2ClassA: 50_000 }, trips))).toEqual(["warn:r2_class_a_day_warn"]);
    const f = evaluate(quiet.snap(), { r2ClassA: 250_000 }, trips);
    expect(f).toMatchObject([{ level: "trip", flip: { switch: "uploads", value: "readonly" } }]);
    quiet.g.ledger.record("r2_class_a", 250_000, undefined, T0);
    expect(rules(evaluate(quiet.snap(), undefined, trips))).toContain("trip:r2_class_a_day");
  });

  it("R2 class B warns at 500,000 a day", () => {
    const s = setup();
    expect(rules(evaluate(s.snap(), { r2ClassB: 500_000 }, trips))).toEqual(["warn:r2_class_b_day_warn"]);
    expect(evaluate(s.snap(), { r2ClassB: 499_999 }, trips)).toEqual([]);
  });

  it("guest drops: 1,000 a day trip demo_drop=off, 3,000 trip guest_files=stopped", () => {
    const s = setup();
    s.g.ledger.record("guest_drop", 1000, "ip", T0);
    expect(evaluate(s.snap(), undefined, trips).map((f) => f.flip)).toEqual([{ switch: "demo_drop", value: "off" }]);
    s.g.ledger.record("guest_drop", 2000, "ip", T0);
    expect(
      evaluate(s.snap(), undefined, trips)
        .flatMap((f) => (f.flip ? [f.flip.switch] : []))
        .sort(),
    ).toEqual(["demo_drop", "guest_files"]);
  });

  it("COST-02 a conversion lease over the pool total, or one that outlived its deadline, trips convert=off", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.g.ledger.acquire("convert", "u", 600, s.g.rig.caps, T0);
    s.g.ledger.acquire("convert_public", undefined, 600, s.g.rig.caps, T0);
    expect(evaluate(s.snap(), undefined, trips)).toEqual([]);
    const leak = setup();
    leak.g.ledger.acquire("convert", "u", 60, leak.g.rig.caps, T0);
    leak.g.clock.now = T0 + 61_000;
    expect(evaluate(leak.snap(), undefined, trips)).toMatchObject([
      { level: "trip", rule: "leases_overdue", flip: { switch: "convert", value: "off" } },
    ]);
  });

  it("COST-03 failed conversions trip convert=account_only only past 20 percent of at least 10", () => {
    const s = setup();
    s.g.ledger.record("conversion_failed", 9, undefined, T0);
    expect(evaluate(s.snap(), undefined, trips)).toEqual([]);
    s.g.ledger.record("conversion_done", 1, undefined, T0);
    expect(rules(evaluate(s.snap(), undefined, trips))).toEqual(["trip:convert_failed"]);
    const ok = setup();
    ok.g.ledger.record("conversion_done", 80, undefined, T0);
    ok.g.ledger.record("conversion_failed", 20, undefined, T0);
    expect(evaluate(ok.snap(), undefined, trips)).toEqual([]);
  });

  it("analytics lines warn and never flip: Workers 1M a day, 3x the 7-day mean over a 50,000 floor, DO, D1, storage", () => {
    const s = setup();
    const w = (r: object) => rules(evaluate(s.snap(), r, trips));
    expect(w({ workersRequests: 1_000_000 })).toEqual(["warn:workers_requests"]);
    expect(w({ workersRequests: 400_000, workersRequests7dMean: 100_000 })).toEqual(["warn:workers_spike"]);
    expect(w({ workersRequests: 40_000, workersRequests7dMean: 100 })).toEqual([]);
    expect(w({ workersRequests: 299_999, workersRequests7dMean: 100_000 })).toEqual([]);
    expect(w({ doRequests: 150_000 })).toEqual(["warn:do_requests"]);
    expect(w({ doGbSeconds: 30_000 })).toEqual(["warn:do_duration"]);
    expect(w({ d1RowsWritten: 1_500_000 })).toEqual(["warn:d1_rows"]);
    expect(w({ r2StorageBytes: 100_000_000_000 })).toEqual(["warn:r2_storage"]);
    expect(evaluate(s.snap(), { workersRequests: 9e9, doRequests: 9e9 }, trips).every((f) => !f.flip)).toBe(true);
  });

  it("a var can move a line: a lower trip line trips sooner", () => {
    const s = setup();
    const lowered = resolveTrips({ BREAKER_R2_A_DAY_TRIP: "100" });
    expect(rules(evaluate(s.snap(), { r2ClassA: 100 }, lowered))).toEqual(["trip:r2_class_a_day"]);
  });
});

describe("runBreaker: flip, latch, alert once", () => {
  it("COST-16 a trip writes the row as breaker, latches, sends one alert, and a second run does neither", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    const first = await s.run();
    expect(first.tripped).toEqual(["demo"]);
    expect(s.store.writes).toEqual([{ name: "demo", value: "off", actor: "breaker", reason: "demo_session_cap" }]);
    expect(s.alerts).toMatchObject([{ kind: "trip", switch: "demo", value: "off", rule: "demo_session_cap" }]);
    await s.run();
    await s.run();
    expect(s.store.writes).toHaveLength(1);
    expect(s.alerts.filter((a) => a.kind === "trip")).toHaveLength(1);
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

  it("escalation: a stricter value on the same switch is a new trip and a new alert", async () => {
    const s = setup();
    s.g.ledger.record("container_seconds", 21_600, undefined, T0);
    await s.run();
    // convert already defaults to account_only, so the first trip latches and alerts without a row write.
    expect(s.store.rows.has("convert")).toBe(false);
    expect(s.g.ledger.trips()).toMatchObject([{ switch: "convert", value: "account_only" }]);
    s.g.ledger.acquire("convert", "u", 60, s.g.rig.caps, T0);
    s.g.clock.now = T0 + 400_000;
    s.g.ledger.record("container_seconds", 1, undefined, s.g.clock.now);
    await s.run();
    expect(s.store.rows.get("convert")).toBe("off");
    expect(s.alerts.filter((a) => a.kind === "trip").map((a) => a.value)).toEqual(["account_only", "off"]);
  });

  it("a trip never loosens a row the owner or the var already made stricter", async () => {
    const s = setup();
    s.store.rows.set("convert", "off");
    s.g.ledger.record("container_seconds", 21_600, undefined, T0);
    await s.run();
    expect(s.store.rows.get("convert")).toBe("off");
    expect(s.store.writes).toHaveLength(0);
    expect(s.alerts.filter((a) => a.kind === "trip")).toHaveLength(1);
  });

  it("a failed row write is retried next run, with no alert until it lands", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    s.store.failNextSet = true;
    await s.run();
    expect(s.store.rows.has("demo")).toBe(false);
    expect(s.alerts.filter((a) => a.kind === "trip")).toHaveLength(0);
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
    expect(s.alerts.filter((a) => a.kind === "trip")).toHaveLength(1);
  });

  it("a failed alert is retried next run and the row is written once", async () => {
    const s = setup();
    let down = true;
    const sent: Alert[] = [];
    s.deps.notify = async (a) => {
      if (down) throw new Error("mail down");
      sent.push(a);
    };
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await runBreaker(s.deps);
    down = false;
    await runBreaker(s.deps);
    await runBreaker(s.deps);
    expect(sent.filter((a) => a.kind === "trip")).toHaveLength(1);
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
    expect(s.alerts.at(-1)).toMatchObject({ kind: "reset", switch: "demo" });
    s.g.clock.now = T0 + DAY;
    expect(await s.run()).toMatchObject({ tripped: [] });
  });

  it("breaker=alert_only: no latch and no row write, a would_trip alert once a day", async () => {
    const s = setup({ SWITCH_BREAKER: "alert_only" });
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    await s.run();
    expect(s.store.writes).toHaveLength(0);
    expect(s.g.ledger.trips()).toHaveLength(0);
    expect(s.alerts).toMatchObject([{ kind: "would_trip", switch: "demo", value: "off" }]);
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
    s.g.ledger.record("email", 150, undefined, T0);
    await s.run();
    await s.run();
    expect(s.alerts.filter((a) => a.kind === "warn")).toHaveLength(1);
    s.g.clock.now = T0 + DAY;
    s.g.ledger.record("email", 150, undefined, s.g.clock.now);
    await s.run();
    expect(s.alerts.filter((a) => a.kind === "warn")).toHaveLength(2);
  });

  it("D1 down for reads and writes: the run completes, the trip latches, and nothing is alerted as applied", async () => {
    const s = setup();
    s.store.get = async () => {
      throw new Error("d1 down");
    };
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await expect(s.run()).resolves.toMatchObject({ tripped: ["demo"] });
    expect(s.g.ledger.trips()).toMatchObject([{ switch: "demo", alerted: false }]);
    expect(s.alerts.filter((a) => a.kind === "trip")).toHaveLength(0);
  });

  it("an alert carries numbers only", async () => {
    const s = setup();
    s.g.ledger.record("email", 300, undefined, T0);
    await s.run();
    for (const a of s.alerts) for (const v of Object.values(a.readings)) expect(typeof v).toBe("number");
  });
});

describe("runBreaker: sources", () => {
  it("without an analytics token every alert says it saw counters only", async () => {
    const s = setup();
    s.g.ledger.record("email", 300, undefined, T0);
    const report = await s.run();
    expect(report.sources).toBe("counters only (no CF_ANALYTICS_TOKEN)");
    expect(s.alerts.every((a) => a.sources.startsWith("counters only"))).toBe(true);
  });

  it("with analytics, a presigned-PUT flood the Worker never counted trips uploads=readonly", async () => {
    const s = setup({}, async () => ({ readings: { r2ClassA: 400_000 }, failed: [] }));
    const report = await s.run();
    expect(report.sources).toBe("counters plus analytics");
    expect(s.store.rows.get("uploads")).toBe("readonly");
  });

  it("three runs in a row with a failed dataset send one analytics_down alert, then no more until a clean run", async () => {
    const s = setup({}, async () => ({ readings: {}, failed: [{ dataset: "d1", error: "bad field" }] }));
    const report = await s.run();
    expect(report.sources).toBe("counters plus analytics (failed: d1)");
    await s.run();
    expect(s.alerts.filter((a) => a.kind === "analytics_down")).toHaveLength(0);
    await s.run();
    await s.run();
    await s.run();
    expect(s.alerts.filter((a) => a.kind === "analytics_down")).toHaveLength(1);
  });

  it("the counters still trip while analytics is down", async () => {
    const s = setup({}, async () => ({ readings: {}, failed: [{ dataset: "workers", error: "x" }] }));
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
  });
});

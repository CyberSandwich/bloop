// The breaker's failure paths: a send that throws, overlapping runs, a failed analytics read, resets, and bad vars.
import { describe, expect, it, vi } from "vitest";
import { RESTRICTIVE } from "../../src/worker/settings.ts";
import type { AnalyticsResult } from "../../src/worker/spend/analytics.ts";
import {
  type Alert,
  type BreakerDeps,
  type DigestMessage,
  PRIOR_UNKNOWN,
  resetAllBreakers,
  resetBreaker,
  runBreaker,
  settingsOf,
} from "../../src/worker/spend/breaker.ts";
import { resolveLines, resolveTrips } from "../../src/worker/spend/caps.ts";
import { effectiveSwitch } from "../../src/worker/spend/switches.ts";
import { DAY, fakeGuard, memoryStore, T0 } from "./spend-helpers.ts";

function setup(vars: Record<string, unknown> = {}, analytics?: BreakerDeps["analytics"], start = T0) {
  const g = fakeGuard(vars, start);
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
  return { g, store, sent, alerts, deps, run: () => runBreaker(deps) };
}

describe("COST-16 a send that throws never stops the run", () => {
  it("a warning that fails to send is retried next run, and a trip still applies the same run", async () => {
    const s = setup();
    let down = true;
    s.deps.notify = async (m) => {
      if (down) throw new Error("mail down");
      s.sent.push(m);
    };
    s.g.ledger.record("email", 50, undefined, T0);
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
    expect(s.sent).toEqual([]);
    down = false;
    await s.run();
    expect(s.alerts().map((a) => `${a.kind}:${a.rule}`)).toEqual(
      expect.arrayContaining(["warn:email_day_warn", "trip:demo_session_cap"]),
    );
    const before = s.sent.length;
    await s.run();
    expect(s.sent).toHaveLength(before);
  });

  it("analytics_down fires at 3 failed runs or more, is retried after a failed send, and is not repeated the same day", async () => {
    const s = setup({}, async () => ({ daily: {}, failed: [{ dataset: "d1", error: "x" }] }));
    let down = true;
    s.deps.notify = async (m) => {
      if (down) throw new Error("mail down");
      s.sent.push(m);
    };
    for (let i = 0; i < 5; i++) await s.run();
    expect(s.sent).toEqual([]);
    down = false;
    await s.run();
    await s.run();
    expect(s.alerts().filter((a) => a.kind === "analytics_down")).toHaveLength(1);
  });

  it("two runs at once send one alert for the same trip", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await Promise.all([s.run(), s.run()]);
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(1);
  });
});

describe("COST-10 D1 write amplification", () => {
  it("d1 rows written at the day's line trip demo=off, counted by the Worker", async () => {
    const s = setup();
    s.g.ledger.record("d1_writes", 33_333, undefined, T0);
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
  });

  it("the same, read from analytics when the Worker never counted it", async () => {
    const s = setup({}, async () => ({ daily: { d1RowsWritten: { "2026-11-25": 40_000 } }, failed: [] }));
    await s.run();
    expect(s.store.rows.get("demo")).toBe("off");
  });
});

describe("a dataset that fails keeps its last good figures", () => {
  it("a presigned-PUT flood seen once still counts when the next read fails", async () => {
    let fail = false;
    const s = setup({}, async () =>
      fail
        ? { daily: {}, failed: [{ dataset: "r2", error: "x" }] }
        : { daily: { r2ClassA: { "2026-11-25": 400_000 } }, r2StorageBytes: 7e9, failed: [] },
    );
    await s.run();
    expect(s.store.rows.get("uploads")).toBe("readonly");
    fail = true;
    await s.g.guard.resetTrip("uploads");
    s.store.rows.delete("uploads");
    s.g.clock.now += 1000;
    await s.run();
    // Not reset by the failure: the held figure trips it again, with the counters at zero.
    expect(s.store.rows.get("uploads")).toBe("readonly");
    const report = JSON.parse((await s.g.guard.report()) as string);
    expect(report.gauges[0].value).toBe(7e9);
    expect(report.meters.find((m: { meter: string }) => m.meter === "r2_class_a").today).toBe(400_000);
  });

  it("the held figure is never lower than the counters", async () => {
    let fail = false;
    const s = setup({}, async () =>
      fail
        ? { daily: {}, failed: [{ dataset: "r2", error: "x" }] }
        : { daily: { r2ClassA: { "2026-11-25": 100 } }, failed: [] },
    );
    await s.run();
    fail = true;
    s.g.ledger.record("r2_class_a", 5000, undefined, T0);
    await s.run();
    const report = JSON.parse((await s.g.guard.report()) as string);
    expect(report.meters.find((m: { meter: string }) => m.meter === "r2_class_a").today).toBe(5000);
  });
});

describe("the month's stop", () => {
  it("stays latched across the 1st until reset: the month resets, the seven rows stay flipped", async () => {
    const s = setup({}, undefined, Date.UTC(2026, 10, 30, 12));
    s.g.ledger.record("container_seconds", 300_000, undefined, Date.UTC(2026, 10, 30, 12));
    await s.run();
    const flipped = [...s.store.rows.entries()].sort();
    expect(flipped.length).toBeGreaterThanOrEqual(7);
    s.g.clock.now = Date.UTC(2026, 11, 1, 3);
    const report = await s.run();
    const stored = JSON.parse((await s.g.guard.report()) as string);
    expect(stored.month).toBe("2026-12");
    expect(stored.monthToDateUsd).toBeLessThan(1);
    expect([...s.store.rows.entries()].sort()).toEqual(flipped);
    expect(report.tripped.length).toBeGreaterThanOrEqual(7);
  });
});

describe("reset restores what was there before, and only what the breaker wrote", () => {
  it("puts back the pre-trip row value", async () => {
    const s = setup();
    s.store.rows.set("uploads", "on");
    s.g.ledger.record("r2_class_a", 11_111, undefined, T0);
    await s.run();
    expect(s.store.rows.get("uploads")).toBe("readonly");
    await resetBreaker(s.deps, "uploads", "owner");
    expect(s.store.rows.get("uploads")).toBe("on");
    expect(s.g.ledger.trips()).toEqual([]);
  });

  it("restores the value from before the first trip, however many tightenings followed", async () => {
    const s = setup();
    s.store.rows.set("convert", "on");
    s.g.ledger.record("container_seconds", 4190, undefined, T0);
    await s.run();
    expect(s.store.rows.get("convert")).toBe("off");
    await resetBreaker(s.deps, "convert", "owner");
    expect(s.store.rows.get("convert")).toBe("on");
  });

  it("leaves a row someone set since: a reset never loosens past a decision the breaker did not make", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    s.store.rows.set("demo", "on");
    await resetBreaker(s.deps, "demo", "owner");
    expect(s.store.rows.get("demo")).toBe("on");
    const writes = s.store.writes.length;
    await resetBreaker(s.deps, "demo", "owner");
    expect(s.store.writes).toHaveLength(writes);
  });

  it("a row that could not be read at latch is restored to nothing: the owner's stricter row survives a reset", async () => {
    const s = setup();
    s.store.unreadable.add("uploads");
    s.g.ledger.record("r2_class_a", 11_111, undefined, T0);
    await s.run();
    expect(s.g.ledger.trips()).toMatchObject([{ switch: "uploads", value: "readonly", prior: PRIOR_UNKNOWN }]);
    s.store.unreadable.clear();
    s.store.rows.set("uploads", "off");
    await s.run();
    expect(s.store.rows.get("uploads")).toBe("off");
    await resetBreaker(s.deps, "uploads", "owner");
    expect(s.store.rows.get("uploads")).toBe("off");
    expect(s.g.ledger.trips()).toEqual([]);
  });

  it("an unknown prior leaves even the breaker's own row alone on reset, rather than writing the default", async () => {
    const s = setup();
    s.store.unreadable.add("uploads");
    s.g.ledger.record("r2_class_a", 11_111, undefined, T0);
    await s.run();
    s.store.unreadable.clear();
    await s.run();
    expect(s.store.rows.get("uploads")).toBe("readonly");
    const writes = s.store.writes.length;
    await resetBreaker(s.deps, "uploads", "owner");
    expect(s.store.rows.get("uploads")).toBe("readonly");
    expect(s.store.writes).toHaveLength(writes);
    expect(s.g.ledger.trips()).toEqual([]);
  });

  it("resetAllBreakers restores every row, and a later identical trip alerts again", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    await s.run();
    expect(await resetAllBreakers(s.deps, "owner")).toEqual(["demo"]);
    expect(s.store.rows.get("demo")).toBe("on");
    s.g.clock.now += 1000;
    await s.run();
    expect(s.alerts().filter((a) => a.kind === "trip")).toHaveLength(2);
  });
});

describe("what is in force decides a write", () => {
  it("a row with a value the switch does not allow counts as the strictest: the breaker leaves it", async () => {
    const s = setup();
    s.store.rows.set("convert", "typo");
    s.g.ledger.record("container_seconds", 4190, undefined, T0);
    await s.run();
    expect(s.store.rows.get("convert")).toBe("typo");
    expect(effectiveSwitch("convert", undefined, s.store.rows.get("convert"))).toBe("off");
  });

  it("a Worker var already at the trip's value needs no row", async () => {
    const s = setup({ SWITCH_CONVERT: "off" });
    s.g.ledger.record("container_seconds", 4190, undefined, T0);
    await s.run();
    expect(s.store.writes).toEqual([]);
    expect(s.g.ledger.trips()).toMatchObject([{ switch: "convert", value: "off" }]);
  });
});

describe("budget, floor, ceiling and cost vars must be above zero", () => {
  it("zero, negative and garbage fall back to the default, logged once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const bad of ["0", "-3", "abc"]) {
      expect(resolveTrips({ BREAKER_BUDGET_MONTH_USD: bad }).budget_month_usd).toBe(10);
      expect(resolveTrips({ BREAKER_GUEST_DROP_COST_USD: bad }).guest_drop_cost_usd).toBe(0.00002);
    }
    const t = resolveTrips({});
    for (const name of ["BREAKER_FLOOR_EMAIL", "BREAKER_CEILING_EMAIL", "BREAKER_SHARE_EMAIL"])
      expect(resolveLines({ [name]: "0" }, t).email).toEqual({ floor: 95, ceiling: 180 });
    const logged = error.mock.calls.map((c) => String(c[0]));
    expect(new Set(logged).size).toBe(logged.length);
    expect(logged.some((l) => l.includes("BREAKER_BUDGET_MONTH_USD"))).toBe(true);
    error.mockRestore();
  });

  it("a computed line of zero trips at once instead of being skipped", async () => {
    // A $0.01 budget over 30 days rounds the email floor to 0 sends.
    const s = setup({ BREAKER_BUDGET_MONTH_USD: "0.01" });
    await s.run();
    expect(s.store.rows.get("email")).toBe("admin_only");
  });
});

describe("the second day's line cannot jump on one abuse day", () => {
  it("a 1,000,000-send day does not move tomorrow's email line past twice today's", async () => {
    const s = setup();
    for (let i = 2; i <= 15; i++) s.g.ledger.record("email", 20, undefined, T0 - i * DAY);
    s.g.ledger.record("email", 1_000_000, undefined, T0 - DAY);
    await s.run();
    const report = JSON.parse((await s.g.guard.report()) as string);
    expect(report.meters.find((m: { meter: string }) => m.meter === "email").tripLine).toBeLessThanOrEqual(190);
  });
});

describe("analytics results are JSON-safe", () => {
  it("the stored last-good blob round-trips", async () => {
    const result: AnalyticsResult = { daily: { d1RowsWritten: { "2026-11-25": 1 } }, r2StorageBytes: 5, failed: [] };
    const s = setup({}, async () => result);
    await s.run();
    expect(JSON.parse((await s.g.guard.lastAnalytics()) as string)).toEqual({
      daily: result.daily,
      r2StorageBytes: 5,
    });
  });
});

describe("an invalid Worker config", () => {
  it("COST-16 the run still trips and says once a day which vars are invalid, by name", async () => {
    const s = setup();
    s.g.ledger.record("demo_session", 2000, undefined, T0);
    const deps: BreakerDeps = { ...s.deps, configProblems: ["CAP_POOL_CONVERT"] };
    await runBreaker(deps);
    await runBreaker(deps);
    const alerts = s.alerts().filter((a) => a.kind === "config_invalid");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.sources).toContain("config invalid (CAP_POOL_CONVERT)");
    expect(s.store.rows.get("demo")).toBe("off");
  });

  it("COST-16 a second var broken later the same day alerts again, and an unnamed problem still alerts", async () => {
    const s = setup();
    await runBreaker({ ...s.deps, configProblems: ["CAP_POOL_CONVERT"] });
    await runBreaker({ ...s.deps, configProblems: ["CAP_POOL_CONVERT", "BREAKER_K"] });
    await runBreaker({ ...s.deps, configProblems: [] });
    const sources = s
      .alerts()
      .filter((a) => a.kind === "config_invalid")
      .map((a) => a.sources);
    expect(sources).toHaveLength(3);
    expect(sources[1]).toContain("(CAP_POOL_CONVERT,BREAKER_K)");
    expect(sources[2]).toContain("(unknown)");
  });
});

describe("the settings reader the breaker is wired to", () => {
  it("a read that fell back to RESTRICTIVE is a failed read, so the guards keep the cap rows they hold", async () => {
    await expect(settingsOf(async () => RESTRICTIVE)()).rejects.toThrow("settings unreadable");
    const rows = { "cap.email_day": "10" };
    await expect(settingsOf(async () => rows)()).resolves.toBe(rows);

    const s = setup();
    await s.g.guard.setOverrides({ email_day: 10 });
    await s.run();
    const failing: BreakerDeps = { ...s.deps, settings: settingsOf(async () => RESTRICTIVE) };
    await runBreaker(failing);
    expect(s.g.rig.caps.email_day).toBe(180);
    expect((await s.g.guard.snapshot()).caps.email_day).toBe(10);
  });
});

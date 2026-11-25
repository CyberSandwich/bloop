import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPS,
  guestDropLines,
  isMeter,
  isPool,
  METERS,
  msToPeriodEnd,
  POOLS,
  PRICED,
  PRICED_METERS,
  periodKey,
  resolveCaps,
  resolveLines,
  resolveTrips,
  TRIPS,
} from "../../src/worker/spend/caps.ts";
import { SWITCH_NAMES, SWITCHES } from "../../src/worker/spend/switches.ts";

const GIB = 1024 ** 3;

describe("caps: every number pinned", () => {
  it("pins each cap's default", () => {
    const defaults = Object.fromEntries(Object.entries(CAPS).map(([k, v]) => [k, v.default]));
    expect(defaults).toEqual({
      pool_convert: 3,
      pool_convert_public: 1,
      pool_export: 4,
      pool_export_per_scope: 1,
      lease_max_convert_seconds: 1800,
      lease_max_export_seconds: 900,
      lease_grace_seconds: 300,
      container_seconds_day: 21_600,
      convert_user_day: 20,
      convert_guest_ip_day: 10,
      convert_demo_day: 200,
      convert_demo_ip_day: 10,
      r2_class_a_month: 1_500_000,
      r2_class_b_month: 15_000_000,
      upload_user_day: 50,
      upload_user_bytes_day: 10 * GIB,
      guest_drop_ip_day: 20,
      email_hour: 60,
      email_day: 300,
      email_recipient_day: 10,
      email_code_ip_day: 20,
      export_user_day: 3,
      demo_session_day: 2000,
    });
  });

  it("pins each breaker line's default", () => {
    const defaults = Object.fromEntries(Object.entries(TRIPS).map(([k, v]) => [k, v.default]));
    expect(defaults).toEqual({
      trip_pct: 100,
      warn_pct: 50,
      month_warn_pct: 80,
      leases_live_max: 4,
      convert_failed_pct: 20,
      convert_failed_min: 10,
      guest_drop_cost_usd: 0.00002,
      guest_drops_demo_off_pct: 5,
      guest_drops_files_stopped_pct: 15,
      budget_month_usd: 10,
      k: 3,
      history_days: 14,
      history_min_days: 7,
      ceiling_multiple: 5,
      ceiling_watch_pct: 70,
      gauge_share_storage_pct: 5,
      share_logs_pct: 10,
      workers_requests_day_warn: 1_000_000,
      workers_spike_multiple: 3,
      workers_spike_floor: 50_000,
      do_requests_day_warn: 150_000,
      do_gb_seconds_day_warn: 30_000,
      analytics_fail_runs: 3,
    });
  });

  it("every var name is unique across caps, trips and switches, and every number has a reason", () => {
    const specs = [...Object.values(CAPS), ...Object.values(TRIPS)];
    const priced = Object.values(PRICED).flatMap((p) => [p.share.var, p.floorVar, p.ceilingVar]);
    const vars = [...specs.map((s) => s.var), ...priced, ...SWITCH_NAMES.map((n) => SWITCHES[n].var)];
    expect(new Set(vars).size).toBe(vars.length);
    for (const s of specs) expect(s.reason.length).toBeGreaterThan(10);
  });

  it("every meter limit and pool names a real cap", () => {
    for (const def of Object.values(METERS) as { global?: { cap: string }[]; perScope?: { cap: string }[] }[])
      for (const l of [...(def.global ?? []), ...(def.perScope ?? [])]) expect(CAPS).toHaveProperty(l.cap);
    for (const p of Object.values(POOLS) as { cap: string; perScopeCap?: string; maxSeconds: string }[]) {
      expect(CAPS).toHaveProperty(p.cap);
      expect(CAPS).toHaveProperty(p.maxSeconds);
      if (p.perScopeCap) expect(CAPS).toHaveProperty(p.perScopeCap);
    }
  });

  it("knows meter and pool names", () => {
    expect(isMeter("email")).toBe(true);
    expect(isMeter("constructor")).toBe(false);
    expect(isPool("convert")).toBe(true);
    expect(isPool("hasOwnProperty")).toBe(false);
  });
});

describe("resolving caps", () => {
  it("uses the default with no var, the var as the maximum, and ignores a bad var", () => {
    expect(resolveCaps({}).email_day).toBe(300);
    expect(resolveCaps({ CAP_EMAIL_DAY: "100" }).email_day).toBe(100);
    expect(resolveCaps({ CAP_EMAIL_DAY: "1000" }).email_day).toBe(1000);
    for (const bad of ["abc", "-5", "", "Infinity", "NaN"])
      expect(resolveCaps({ CAP_EMAIL_DAY: bad }).email_day).toBe(300);
    expect(resolveCaps({ CAP_EMAIL_DAY: "0" }).email_day).toBe(0);
  });

  it("an override can lower a cap and never raise it", () => {
    expect(resolveCaps({}, { email_day: 50 }).email_day).toBe(50);
    expect(resolveCaps({}, { email_day: 5000 }).email_day).toBe(300);
    expect(resolveCaps({ CAP_EMAIL_DAY: "100" }, { email_day: 200 }).email_day).toBe(100);
    expect(resolveCaps({}, { email_day: -1 }).email_day).toBe(300);
    expect(resolveCaps({}, { email_day: Number.NaN }).email_day).toBe(300);
  });

  it("trips read their vars the same way", () => {
    expect(resolveTrips({}).budget_month_usd).toBe(10);
    expect(resolveTrips({ BREAKER_BUDGET_MONTH_USD: "25" }).budget_month_usd).toBe(25);
    expect(resolveTrips({ BREAKER_BUDGET_MONTH_USD: "x" }).budget_month_usd).toBe(10);
  });
});

describe("the $10 month split: each meter's daily floor", () => {
  const t = resolveTrips({});

  it("shares of the budget, with storage and logs, add to 100 percent", () => {
    const shares = Object.values(PRICED).map((p) => p.share.default);
    expect(shares.reduce((a, b) => a + b, 0) + t.gauge_share_storage_pct + t.share_logs_pct).toBe(100);
  });

  it("pins each floor: share times $10 over 30 days, divided by the unit price", () => {
    const lines = resolveLines({}, t);
    expect(Object.fromEntries(PRICED_METERS.map((m) => [m, lines[m].floor]))).toEqual({
      container_seconds: 3724,
      r2_class_a: 11_111,
      r2_class_b: 46_296,
      d1_writes: 33_333,
      workflow_steps: 2083,
      email: 95,
    });
  });

  it("each floor costs its share of a day: $0.133 containers, $0.05 R2 A, $0.017 R2 B, $0.033 D1, $0.017 steps, $0.033 email", () => {
    const lines = resolveLines({}, t);
    const usd = Object.fromEntries(PRICED_METERS.map((m) => [m, (lines[m].floor * PRICED[m].unitUsd).toFixed(3)]));
    expect(usd).toEqual({
      container_seconds: "0.133",
      r2_class_a: "0.050",
      r2_class_b: "0.017",
      d1_writes: "0.033",
      workflow_steps: "0.017",
      email: "0.033",
    });
  });

  it("the default ceiling is 5 times the floor", () => {
    const lines = resolveLines({}, t);
    for (const m of PRICED_METERS) expect(lines[m].ceiling).toBe(lines[m].floor * 5);
  });

  it("the budget var rescales every floor; a floor or ceiling var replaces one", () => {
    const doubled = resolveLines({ BREAKER_BUDGET_MONTH_USD: "20" }, resolveTrips({ BREAKER_BUDGET_MONTH_USD: "20" }));
    expect(doubled.email.floor).toBe(190);
    const set = resolveLines({ BREAKER_FLOOR_EMAIL: "100", BREAKER_CEILING_EMAIL: "1000" }, t);
    expect(set.email).toEqual({ floor: 100, ceiling: 1000 });
    expect(set.r2_class_a.floor).toBe(11_111);
  });

  it("a ceiling below the floor is raised to the floor, so the line can never sit under it", () => {
    expect(resolveLines({ BREAKER_CEILING_EMAIL: "10" }, t).email).toEqual({ floor: 95, ceiling: 95 });
  });
});

describe("guest-drop lines are shares of the budget", () => {
  it("833 and 2,500 a day at the defaults, and they scale with the budget and the drop cost", () => {
    expect(guestDropLines(resolveTrips({}))).toEqual({ demoOff: 833, filesStopped: 2500 });
    expect(guestDropLines(resolveTrips({ BREAKER_BUDGET_MONTH_USD: "20" }))).toEqual({
      demoOff: 1667,
      filesStopped: 5000,
    });
    expect(guestDropLines(resolveTrips({ BREAKER_GUEST_DROP_COST_USD: "0.00004" }))).toEqual({
      demoOff: 417,
      filesStopped: 1250,
    });
  });
});

describe("periods", () => {
  const at = Date.UTC(2026, 11, 31, 23, 59, 59, 500);
  it("keys are UTC and sort in time order", () => {
    expect(periodKey("hour", at)).toBe("h2026-12-31T23");
    expect(periodKey("day", at)).toBe("d2026-12-31");
    expect(periodKey("month", at)).toBe("m2026-12");
    expect(periodKey("day", at + 1000) > periodKey("day", at)).toBe(true);
  });

  it("time to the end of a period crosses day, month and year edges", () => {
    expect(msToPeriodEnd("hour", at)).toBe(500);
    expect(msToPeriodEnd("day", at)).toBe(500);
    expect(msToPeriodEnd("month", at)).toBe(500);
    expect(msToPeriodEnd("day", Date.UTC(2026, 10, 25, 12))).toBe(12 * 3_600_000);
  });
});

describe("docs/spend.md is the owner doc and names every switch, cap and line", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../docs/spend.md", import.meta.url)), "utf8");
  const row = (name: string, value: string | number) => new RegExp(`\\|\\s*\`${name}\`\\s*\\|[^\\n]*${value}`);

  it("lists each switch with its var and default", () => {
    for (const n of SWITCH_NAMES) {
      expect(doc, n).toMatch(row(n, SWITCHES[n].default));
      expect(doc, SWITCHES[n].var).toContain(SWITCHES[n].var);
    }
  });

  it("lists each cap with its var and number", () => {
    for (const [name, s] of Object.entries(CAPS)) {
      const shown = s.default >= 1_000_000 ? s.default.toLocaleString("en-US") : s.default.toString();
      expect(doc, name).toMatch(row(s.var, shown.replace(/,/g, ",?")));
    }
  });

  it("lists each breaker line with its var and number", () => {
    for (const [name, s] of Object.entries(TRIPS)) {
      const shown = s.default >= 1000 ? s.default.toLocaleString("en-US") : s.default.toString();
      expect(doc, name).toMatch(row(s.var, shown));
    }
  });

  it("lists each priced meter with its share, floor and ceiling vars and its unit price", () => {
    const t = resolveTrips({});
    const lines = resolveLines({}, t);
    for (const m of PRICED_METERS) {
      const p = PRICED[m];
      expect(doc, m).toMatch(row(m, p.share.default));
      for (const v of [p.share.var, p.floorVar, p.ceilingVar]) expect(doc, v).toContain(v);
      expect(doc, m).toContain(lines[m].floor.toLocaleString("en-US"));
      expect(doc, m).toContain(`$${(p.unitUsd * 1e6).toFixed(2)} per million`);
      expect(doc, m).toContain(lines[m].ceiling.toLocaleString("en-US"));
    }
  });
});

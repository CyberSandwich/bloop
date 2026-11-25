import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPS,
  isMeter,
  isPool,
  METERS,
  msToPeriodEnd,
  POOLS,
  periodKey,
  resolveCaps,
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
      guest_drops_demo_off_day: 1000,
      guest_drops_files_stopped_day: 3000,
      r2_class_a_day_warn: 50_000,
      r2_class_a_day_trip: 250_000,
      r2_class_b_day_warn: 500_000,
      r2_storage_bytes_warn: 100_000_000_000,
      d1_rows_day_warn: 1_500_000,
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
    const vars = [...specs.map((s) => s.var), ...SWITCH_NAMES.map((n) => SWITCHES[n].var)];
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
    expect(resolveTrips({}).r2_class_a_day_trip).toBe(250_000);
    expect(resolveTrips({ BREAKER_R2_A_DAY_TRIP: "10" }).r2_class_a_day_trip).toBe(10);
    expect(resolveTrips({ BREAKER_R2_A_DAY_TRIP: "x" }).r2_class_a_day_trip).toBe(250_000);
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
});

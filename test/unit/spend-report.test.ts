import { describe, expect, it } from "vitest";
import type { AnalyticsResult } from "../../src/worker/spend/analytics.ts";
import {
  type Caps,
  PRICED,
  PRICED_METERS,
  p95,
  resolveCaps,
  resolveLines,
  resolveTrips,
  tripLine,
} from "../../src/worker/spend/caps.ts";
import {
  buildReport,
  digestText,
  isMonday,
  nextReviewDate,
  REPORT_DAYS,
  type SpendReport,
  weekKey,
} from "../../src/worker/spend/report.ts";
import { DAY, rig, T0 } from "./spend-helpers.ts";

const t = resolveTrips({});
// The email day cap is raised so the default ceiling is 5 x floor: floor 95, ceiling 475.
const VARS = { CAP_EMAIL_DAY: "1000" };
const email = resolveLines(VARS, t).email;

describe("p95", () => {
  it("is nearest-rank: the 19th of 20, the maximum of 14, and 0 for nothing", () => {
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(p95([5, 1, 9, 2, 3, 4, 8, 7, 6, 10, 11, 12, 13, 100])).toBe(100);
    expect(p95([7])).toBe(7);
    expect(p95([])).toBe(0);
  });

  it("does not reorder its input", () => {
    const xs = [3, 1, 2];
    p95(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("the adaptive trip line: clamp(max(floor, k x p95), floor, ceiling)", () => {
  const days = (n: number, v: number) => Array.from({ length: n }, () => v);

  it("COST-14 with fewer than 7 days of history the line is the floor, however large the history", () => {
    expect(tripLine(email, days(0, 0), t)).toBe(95);
    expect(tripLine(email, days(6, 400), t)).toBe(95);
    expect(tripLine(email, days(7, 400), t)).toBe(190);
  });

  it("the line rises at most 2x a day: 14 days of 400 climb 95, 190, 380, 475 over the days that count", () => {
    const climb = (n: number) => tripLine(email, days(n, 400), t);
    expect([7, 8, 9, 10, 14].map(climb)).toEqual([190, 380, 475, 475, 475]);
  });

  it("an abuse day lifts the next day's line at most to twice the day before's, not to 3 x the spike", () => {
    const spikeYesterday = [1_000_000, ...days(13, 20)];
    expect(tripLine(email, spikeYesterday, t)).toBe(190);
    // The day after, the spike is in the window and the line may double again.
    expect(tripLine(email, [20, ...spikeYesterday], t)).toBe(380);
  });

  it("the growth step is a var and the floor is always allowed", () => {
    expect(tripLine(email, days(7, 400), { ...t, line_growth_multiple: 1 })).toBe(95);
    expect(tripLine(email, days(7, 400), { ...t, line_growth_multiple: 10 })).toBe(475);
  });

  it("quiet history never lowers the line under the floor", () => {
    expect(tripLine(email, days(14, 0), t)).toBe(95);
    expect(tripLine(email, days(14, 10), t)).toBe(95);
  });

  it("grows with usage: 3 times the p95 once that passes the floor", () => {
    expect(tripLine(email, days(14, 50), t)).toBe(150);
    expect(tripLine(email, [...days(13, 50), 60], t)).toBe(180);
  });

  it("never exceeds the ceiling, however large the history or k", () => {
    expect(tripLine(email, days(14, 1_000_000), t)).toBe(475);
    expect(tripLine(email, days(14, 1e12), { ...t, k: 1000 })).toBe(475);
    for (let seed = 1; seed <= 200; seed++) {
      const history = Array.from({ length: 14 }, (_, i) => ((seed * 7919 + i * 104_729) % 100_003) * (seed % 5));
      const line = tripLine(email, history, t);
      expect(line).toBeLessThanOrEqual(email.ceiling);
      expect(line).toBeGreaterThanOrEqual(email.floor);
    }
  });

  it("a ceiling the owner raises lifts the cap on the line", () => {
    const high = resolveLines({ BREAKER_CEILING_EMAIL: "5000" }, t).email;
    expect(tripLine(high, days(14, 1000), t)).toBe(3000);
    expect(tripLine(high, days(14, 1_000_000), t)).toBe(5000);
  });

  it("one abuse day lifts the line at most to the ceiling", () => {
    expect(tripLine(email, [...days(13, 20), 1_000_000], t)).toBe(475);
  });
});

/** A ledger that has seen `perDay` of a meter every day for the 10 days before T0 (born 20 days before). */
function usage(meter: "email" | "r2_class_a" | "container_seconds", perDay: number, today = 0, age = 20) {
  const r = rig({}, T0 - age * DAY);
  for (let i = 1; i <= 10; i++) r.ledger.record(meter, perDay, undefined, T0 - i * DAY);
  if (today) r.ledger.record(meter, today, undefined, T0);
  return r;
}

const reportOf = (
  r: ReturnType<typeof rig>,
  extra: { analytics?: AnalyticsResult; vars?: Record<string, unknown>; caps?: Caps } = {},
) =>
  buildReport({
    now: T0,
    vars: extra.vars ?? VARS,
    history: r.ledger.history(T0, REPORT_DAYS),
    // The guard's caps: the same vars, lowered by any row.
    snapshot: r.ledger.snapshot(T0, extra.caps ?? resolveCaps(extra.vars ?? VARS)),
    ...(extra.analytics ? { analytics: extra.analytics } : {}),
    adminUrl: "https://bloop.example/admin",
    sources: "counters only (no CF_ANALYTICS_TOKEN)",
  });
const rowOf = (rep: SpendReport, m: string) => {
  const row = rep.meters.find((x) => x.meter === m);
  if (!row) throw new Error(`no ${m} row in the report`);
  return row;
};

describe("the report", () => {
  it("a cap.email_day row lowers the email ceiling the report and the breaker use", () => {
    const row = rowOf(reportOf(usage("email", 40, 12), { caps: resolveCaps(VARS, { email_day: 100 }) }), "email");
    expect(row).toMatchObject({ floor: 95, ceiling: 100 });
    expect(row.tripLine).toBeLessThanOrEqual(100);
  });

  it("lists every priced meter with today, 7 and 30 days, month to date, its cost and its line", () => {
    const r = usage("email", 40, 12);
    const row = rowOf(reportOf(r), "email");
    expect(row).toMatchObject({
      today: 12,
      last7: 12 + 6 * 40,
      last30: 12 + 10 * 40,
      historyDays: 14,
      p95: 40,
      floor: 95,
      ceiling: 475,
      tripLine: 120,
      warnLine: 60,
      ceilingVar: "BREAKER_CEILING_EMAIL",
    });
    // November 1 to 25 holds all 11 days of usage.
    expect(row.monthToDate).toBe(12 + 400);
    expect(row.monthToDateUsd).toBeCloseTo(412 * PRICED.email.unitUsd, 2);
    expect(rowOf(reportOf(r), "container_seconds")).toMatchObject({ tripLine: 4190, today: 0 });
    expect(reportOf(r).meters.map((m) => m.meter)).toEqual(PRICED_METERS);
  });

  it("a young guard (3 completed days) uses the floor and says how much history it has", () => {
    const r = usage("email", 400, 0, 3);
    expect(rowOf(reportOf(r), "email")).toMatchObject({ historyDays: 3, tripLine: 95 });
  });

  it("month to date counts only this UTC month, and the total adds up and projects the month", () => {
    const r = rig({}, T0 - 40 * DAY);
    r.ledger.record("container_seconds", 1000, undefined, T0 - 30 * DAY);
    r.ledger.record("container_seconds", 1000, undefined, T0 - 2 * DAY);
    r.ledger.record("container_seconds", 1000, undefined, T0);
    const rep = reportOf(r);
    expect(rowOf(rep, "container_seconds").monthToDate).toBe(2000);
    expect(rep.monthToDateUsd).toBeCloseTo(2000 * 0.0000358, 2);
    expect(rep.projectedUsd).toBeCloseTo(((2000 * 0.0000358) / 25) * 30, 2);
    expect(rep.month).toBe("2026-11");
    expect(rep.budgetUsd).toBe(10);
    expect(rep.nextReview).toBe("2026-12-07");
    expect(rep.adminUrl).toBe("https://bloop.example/admin");
    expect(rep.unmeasured).toEqual(["log ingest (no dataset read yet)"]);
  });

  it("when analytics saw more than the counter (presigned PUTs), the day takes the larger", () => {
    const r = usage("r2_class_a", 100, 50);
    const analytics: AnalyticsResult = {
      daily: { r2ClassA: { "2026-11-25": 90_000, "2026-11-24": 10 } },
      r2StorageBytes: 20e9,
      failed: [],
    };
    const row = rowOf(reportOf(r, { analytics }), "r2_class_a");
    expect(row.today).toBe(90_000);
    expect(row.last7).toBe(90_000 + 100 * 6);
  });

  it("with analytics the history is long enough to learn from on day one, and the storage gauge is priced", () => {
    const r = rig({}, T0);
    const daily: Record<string, number> = {};
    for (let i = 1; i <= 20; i++) daily[new Date(T0 - i * DAY).toISOString().slice(0, 10)] = 300;
    const rep = reportOf(r, { analytics: { daily: { r2ClassA: daily }, r2StorageBytes: 20e9, failed: [] } });
    expect(rowOf(rep, "r2_class_a")).toMatchObject({ historyDays: 14, p95: 300, tripLine: 11_111 });
    expect(rep.gauges).toEqual([{ name: "r2_storage_bytes", value: 20e9, warnAt: 33_333_333_333, usd: 0.3 }]);
    expect(rep.monthToDateUsd).toBeGreaterThanOrEqual(0.3);
  });

  it("flags a meter that wants 70 percent of its ceiling and suggests doubling it", () => {
    const r = usage("email", 110);
    const row = rowOf(reportOf(r), "email");
    expect(row.tripLine).toBe(330);
    expect(row).toMatchObject({ wantPctOfCeiling: 69, nearCeiling: false });
    const hot = rowOf(reportOf(usage("email", 120)), "email");
    expect(hot).toMatchObject({ wantPctOfCeiling: 76, nearCeiling: true, suggestedCeiling: 950 });
  });

  it("prices Workers and Durable Objects only to suggest platform limits, never under $10", () => {
    const daily = { workersRequests: {} as Record<string, number>, doRequests: {} as Record<string, number> };
    for (let i = 0; i < 25; i++) {
      const d = new Date(T0 - i * DAY).toISOString().slice(0, 10);
      daily.workersRequests[d] = 10_000_000;
      daily.doRequests[d] = 2_000_000;
    }
    const rep = reportOf(rig({}, T0 - 20 * DAY), { analytics: { daily, failed: [] } });
    // 250M requests at $0.30 per million plus 50M DO requests at $0.15 per million, over 25 days.
    expect(rep.platform?.monthToDateUsd).toBeCloseTo(82.5, 1);
    expect(rep.platform?.suggestedLimitUsd).toBe(200);
    expect(reportOf(rig()).platform).toBeUndefined();
    const quiet = reportOf(rig(), { analytics: { daily: { workersRequests: { "2026-11-25": 5 } }, failed: [] } });
    expect(quiet.platform?.suggestedLimitUsd).toBe(10);
  });

  it("is JSON the admin route can send as it is", () => {
    const rep = reportOf(usage("email", 40, 12));
    expect(JSON.parse(JSON.stringify(rep))).toEqual(rep);
  });
});

describe("review dates and weeks", () => {
  const d = (s: string) => Date.parse(`${s}T09:00:00Z`);

  it("the next monthly review is the first Monday of this month while it is ahead, else of next month", () => {
    expect(nextReviewDate(d("2026-11-25"))).toBe("2026-12-07");
    expect(nextReviewDate(d("2026-12-01"))).toBe("2026-12-07");
    expect(nextReviewDate(d("2026-12-07"))).toBe("2026-12-07");
    expect(nextReviewDate(d("2026-12-08"))).toBe("2027-01-04");
    expect(nextReviewDate(d("2026-10-01"))).toBe("2026-10-05");
    expect(nextReviewDate(d("2026-11-02"))).toBe("2026-11-02");
  });

  it("knows Monday and the ISO week", () => {
    expect(isMonday(d("2026-11-30"))).toBe(true);
    expect(isMonday(d("2026-11-29"))).toBe(false);
    expect(weekKey(d("2026-11-30"))).toBe("2026-W49");
    expect(weekKey(d("2026-12-06"))).toBe("2026-W49");
    expect(weekKey(d("2026-12-07"))).toBe("2026-W50");
    expect(weekKey(d("2027-01-01"))).toBe("2026-W53");
  });
});

describe("the digest", () => {
  const rep = (r: ReturnType<typeof rig>) => reportOf(r);

  it("names each meter's 7 days, line, floor, ceiling and month cost, and ends with the next review and the admin link", () => {
    const { subject, text } = digestText(rep(usage("email", 40, 12)));
    expect(subject).toBe("bloop spend digest 2026-W48");
    expect(text).toContain(
      "Email: 7 days 252 sends; month $0.14; trip line 120 a day (floor 95, ceiling 475); 14 days of history.",
    );
    expect(text).toContain("Containers:");
    expect(text).toContain("Not measured: log ingest");
    const lines = text.trimEnd().split("\n");
    expect(lines.at(-2)).toBe("Next monthly review: 2026-12-07 (first Monday).");
    expect(lines.at(-1)).toBe("Admin: https://bloop.example/admin");
  });

  it("says when a meter wants 70 percent of its ceiling, suggests the new ceiling and the platform limits", () => {
    const { text } = digestText(rep(usage("email", 120)));
    expect(text).toContain("Email: wants 76 percent of its ceiling. Suggest BREAKER_CEILING_EMAIL 950 (double).");
    expect(text).toContain("platform spend limits");
  });

  it("stays quiet about growth when nothing is near a ceiling, and lists latched trips", () => {
    const quiet = digestText(rep(usage("email", 40)));
    expect(quiet.text).not.toContain("Growth");
    const r = usage("email", 40);
    r.ledger.latchTrip("convert", "off", "month_budget", "{}", T0);
    expect(digestText(rep(r)).text).toContain("Latched trips: convert=off.");
  });

  it("carries the platform suggestion when analytics read Workers and Durable Objects", () => {
    const r = rig();
    const report = reportOf(r, { analytics: { daily: { workersRequests: { "2026-11-25": 1 } }, failed: [] } });
    expect(digestText(report).text).toContain("Suggested platform spend limit $10 each.");
  });
});

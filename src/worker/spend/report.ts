// The numbers the owner reads: per meter today, 7 and 30 days, month to date, the adaptive trip line and its ceiling,
// and the month-to-date cost against the budget. One pure builder feeds the breaker's rules, the /admin panel, the
// admin JSON route and the weekly digest, so they cannot disagree. Pure: no Workers module, no clock but `now`.
import { ANALYTICS_DAYS, type AnalyticsResult, dateKey, type SeriesName } from "./analytics.ts";
import {
  type Line,
  PLATFORM_USD,
  PRICED,
  PRICED_METERS,
  type PricedMeter,
  p95,
  R2_STORAGE_USD_PER_GB,
  resolveLines,
  resolveTrips,
  tripLine,
} from "./caps.ts";
import type { History, Snapshot, TripRow } from "./meters.ts";

const DAY_MS = 86_400_000;
const SERIES_OF: Partial<Record<PricedMeter, SeriesName>> = {
  r2_class_a: "r2ClassA",
  r2_class_b: "r2ClassB",
  d1_writes: "d1RowsWritten",
};
/** Days of history the report asks the guard for: the longest month plus today. */
export const REPORT_DAYS = 32;

export interface MeterRow {
  meter: PricedMeter;
  label: string;
  unit: string;
  today: number;
  last7: number;
  last30: number;
  monthToDate: number;
  monthToDateUsd: number;
  /** Trailing p95 of completed days, 0 until there is any history. */
  p95: number;
  /** Completed days the p95 was taken over; under the minimum the line is the floor. */
  historyDays: number;
  floor: number;
  ceiling: number;
  tripLine: number;
  warnLine: number;
  /** What k times the p95 asks for, as a percent of the ceiling: at the watch percent the digest suggests a raise. */
  wantPctOfCeiling: number;
  nearCeiling: boolean;
  suggestedCeiling: number;
  /** The var that raises the ceiling. */
  ceilingVar: string;
}

export interface SpendReport {
  at: number;
  month: string;
  budgetUsd: number;
  monthToDateUsd: number;
  projectedUsd: number;
  percentOfBudget: number;
  meters: MeterRow[];
  gauges: { name: string; value: number; warnAt: number; usd: number }[];
  /** Workers and Durable Objects: priced only to size their platform spend limits; absent without analytics. */
  platform?: { monthToDateUsd: number; projectedUsd: number; suggestedLimitUsd: number };
  trips: TripRow[];
  /** What no meter reads yet. */
  unmeasured: string[];
  sources: string;
  nextReview: string;
  adminUrl: string;
}

export interface ReportInput {
  now: number;
  vars: Readonly<Record<string, unknown>>;
  history: History;
  snapshot: Snapshot;
  analytics?: AnalyticsResult;
  adminUrl: string;
  sources: string;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const daysInMonth = (at: number) =>
  new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 0)).getUTCDate();
const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;

/** First Monday of the month containing `at`, as a UTC day start. */
function firstMonday(year: number, month: number): number {
  const first = Date.UTC(year, month, 1);
  return first + ((8 - new Date(first).getUTCDay()) % 7) * DAY_MS;
}

/** The next monthly review: the first Monday of this month if it is today or later, else of next month. */
export function nextReviewDate(now: number): string {
  const d = new Date(now);
  const today = now - (now % DAY_MS);
  let when = firstMonday(d.getUTCFullYear(), d.getUTCMonth());
  if (when < today) when = firstMonday(d.getUTCFullYear(), d.getUTCMonth() + 1);
  return dateKey(when);
}

export const isMonday = (now: number): boolean => new Date(now).getUTCDay() === 1;

/** ISO week key such as 2026-W48, so a digest is claimed once per week. */
export function weekKey(now: number): string {
  const d = new Date(now - (now % DAY_MS));
  const thursday = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * DAY_MS);
  const week = Math.floor((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / (7 * DAY_MS)) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function buildReport(input: ReportInput): SpendReport {
  const { now, vars, history, analytics } = input;
  const t = resolveTrips(vars);
  const lines = resolveLines(vars, t);
  const dayOfMonth = new Date(now).getUTCDate();
  const month = dateKey(now).slice(0, 7);

  const meters = PRICED_METERS.map((meter): MeterRow => {
    const p = PRICED[meter];
    const seriesName = SERIES_OF[meter];
    const theirs = seriesName ? analytics?.daily[seriesName] : undefined;
    // Counted by bloop or read from Cloudflare, whichever saw more that day: presigned PUTs never pass a meter.
    const days = Array.from({ length: REPORT_DAYS }, (_, i) =>
      Math.max(history.series[meter][i] ?? 0, theirs ? (theirs[dateKey(now - i * DAY_MS)] ?? 0) : 0),
    );
    const completedAvailable = theirs ? ANALYTICS_DAYS - 1 : history.ageDays;
    // Every completed day on hand, newest first: the line is built day by day so its growth is bounded.
    const all = days.slice(1, 1 + Math.min(REPORT_DAYS - 1, completedAvailable));
    const completed = all.slice(0, t.history_days);
    const line: Line = lines[meter];
    const trip = tripLine(line, all, t);
    const pct = completed.length >= t.history_min_days ? ((t.k * p95(completed)) / line.ceiling) * 100 : 0;
    const mtd = sum(days.slice(0, dayOfMonth));
    return {
      meter,
      label: p.label,
      unit: p.unit,
      today: days[0] ?? 0,
      last7: sum(days.slice(0, 7)),
      last30: sum(days.slice(0, 30)),
      monthToDate: mtd,
      monthToDateUsd: round2(mtd * p.unitUsd),
      p95: p95(completed),
      historyDays: completed.length,
      floor: line.floor,
      ceiling: line.ceiling,
      tripLine: trip,
      warnLine: (trip * t.warn_pct) / 100,
      wantPctOfCeiling: Math.round(pct),
      nearCeiling: pct >= t.ceiling_watch_pct,
      suggestedCeiling: line.ceiling * 2,
      ceilingVar: p.ceilingVar,
    };
  });

  const storageBytes = analytics?.r2StorageBytes;
  const storageWarn = Math.round(
    ((t.gauge_share_storage_pct / 100) * t.budget_month_usd * 1e9) / R2_STORAGE_USD_PER_GB,
  );
  const gauges =
    storageBytes === undefined
      ? []
      : [
          {
            name: "r2_storage_bytes",
            value: storageBytes,
            warnAt: storageWarn,
            usd: round2((storageBytes / 1e9) * R2_STORAGE_USD_PER_GB),
          },
        ];

  // Summed unrounded, so the total does not drift from the rows by their rounding.
  const metered = sum(meters.map((m) => m.monthToDate * PRICED[m.meter].unitUsd));
  const storageUsd = gauges[0]?.usd ?? 0;
  const monthToDateUsd = round2(metered + storageUsd);
  const projectedUsd = round2((metered / dayOfMonth) * daysInMonth(now) + storageUsd);

  const report: SpendReport = {
    at: now,
    month,
    budgetUsd: t.budget_month_usd,
    monthToDateUsd,
    projectedUsd,
    percentOfBudget: Math.round((monthToDateUsd / t.budget_month_usd) * 100),
    meters,
    gauges,
    trips: input.snapshot.trips,
    unmeasured: ["log ingest (no dataset read yet)"],
    sources: input.sources,
    nextReview: nextReviewDate(now),
    adminUrl: input.adminUrl,
  };
  const platform = platformCost(analytics, now);
  if (platform) report.platform = platform;
  return report;
}

/** Month-to-date, projected and a suggested platform spend limit for Workers plus Durable Objects together. */
function platformCost(a: AnalyticsResult | undefined, now: number): SpendReport["platform"] | undefined {
  if (!a?.daily.workersRequests && !a?.daily.doRequests) return undefined;
  const day = new Date(now).getUTCDate();
  const monthSum = (name: SeriesName) => {
    const s = a.daily[name];
    let total = 0;
    for (let i = 0; i < day; i++) total += s?.[dateKey(now - i * DAY_MS)] ?? 0;
    return total;
  };
  const usd =
    (monthSum("workersRequests") / 1e6) * PLATFORM_USD.workersPerMillion +
    (monthSum("doRequests") / 1e6) * PLATFORM_USD.doRequestsPerMillion +
    (monthSum("doGbSeconds") / 1e6) * PLATFORM_USD.doGbSecondsPerMillion;
  const projected = (usd / day) * daysInMonth(now);
  return {
    monthToDateUsd: round2(usd),
    projectedUsd: round2(projected),
    // About twice the month's expected cost, never under the $10 the dashboard limits start at.
    suggestedLimitUsd: Math.max(10, roundUp(2 * projected, 5)),
  };
}

const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** The Monday email: plain text, numbers only. Ends with the next review date and the admin link. */
export function digestText(r: SpendReport): { subject: string; text: string } {
  const lines = [
    `bloop spend, week of ${dateKey(r.at)}`,
    "",
    `Month to date ${r.month}: $${r.monthToDateUsd.toFixed(2)} of $${r.budgetUsd.toFixed(2)} (${r.percentOfBudget} percent); projected $${r.projectedUsd.toFixed(2)}.`,
    `Sources: ${r.sources}.`,
    "",
  ];
  for (const m of r.meters) {
    lines.push(
      `${m.label}: 7 days ${n(m.last7)} ${m.unit}; month $${m.monthToDateUsd.toFixed(2)}; trip line ${n(m.tripLine)} a day (floor ${n(m.floor)}, ceiling ${n(m.ceiling)}); ${m.historyDays} days of history.`,
    );
  }
  for (const g of r.gauges)
    lines.push(`R2 storage: ${n(g.value / 1e9)} GB, warns at ${n(g.warnAt / 1e9)} GB; $${g.usd.toFixed(2)} a month.`);
  for (const u of r.unmeasured) lines.push(`Not measured: ${u}.`);
  const near = r.meters.filter((m) => m.nearCeiling);
  if (near.length > 0) {
    lines.push(
      "",
      "Growth: these meters want a trip line near their ceiling. Raise the ceiling before the line binds.",
    );
    for (const m of near)
      lines.push(
        `  ${m.label}: wants ${m.wantPctOfCeiling} percent of its ceiling. Suggest ${m.ceilingVar} ${n(m.suggestedCeiling)} (double).`,
      );
    lines.push(
      "  Raise the matching Workers and Durable Objects platform spend limits and the budget alerts in step (docs/spend.md, Review and adjust).",
    );
  }
  if (r.platform)
    lines.push(
      "",
      `Workers and Durable Objects: month to date $${r.platform.monthToDateUsd.toFixed(2)}, projected $${r.platform.projectedUsd.toFixed(2)}. Suggested platform spend limit $${r.platform.suggestedLimitUsd} each.`,
    );
  if (r.trips.length > 0)
    lines.push(
      "",
      `Latched trips: ${r.trips.map((t) => `${t.switch}=${t.value}`).join(", ")}. Reset in /admin when ready.`,
    );
  lines.push("", `Next monthly review: ${r.nextReview} (first Monday).`, `Admin: ${r.adminUrl}`);
  return { subject: `bloop spend digest ${weekKey(r.at)}`, text: lines.join("\n") };
}

// Metrics seam (docs/interfaces.md section 7). The Screen object calls `record` at the transitions
// that carry a measurement; the D1 implementation is metrics-d1.ts, picked in stores.ts.
import type { ErrorCode, Kind, Mode } from "../shared/protocol.ts";
import type { MetricName } from "./machine.ts";

export type FailureCause = ErrorCode | "screen_offline" | "phone_offline";
export interface MetricEvent {
  at: number;
  mode: Mode;
  kind: Kind;
  roomId: string | null;
  name: MetricName;
  ms?: number;
  cause?: FailureCause;
}

/** One line of the aggregate: a measurement or a failure cause over a range. `cause` is "" when there is none. */
export interface MetricSummary {
  mode: Mode;
  name: MetricName;
  cause: string;
  n: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface Metrics {
  record(e: MetricEvent): Promise<void>;
  /** Week-3 return: one row per pseudonymous user per ISO week. */
  activeWeek(userId: string, now: number): Promise<void>;
  /** Counts and percentiles per mode, name and cause over `[from, to)`: time to first open, failures by cause. */
  summary(from: number, to: number): Promise<MetricSummary[]>;
  rollup(day: string): Promise<void>; // metric_event to metric_daily
  /** Rolls every event day older than `days` into metric_daily, then deletes those events; drops expired rollups and weeks. */
  purge(now: number, days: number): Promise<number>;
}

const DAY_MS = 86_400_000;

/** Nearest-rank percentile of an ascending list. Null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export interface MetricRow {
  mode: Mode;
  name: MetricName;
  cause: string;
  ms: number | null;
}

/** Groups rows by mode, name and cause. Percentiles come from the rows that carry a duration. */
export function summarize(rows: readonly MetricRow[]): MetricSummary[] {
  const groups = new Map<string, { mode: Mode; name: MetricName; cause: string; ms: number[]; n: number }>();
  for (const r of rows) {
    const key = `${r.mode}|${r.name}|${r.cause}`;
    const g = groups.get(key) ?? { mode: r.mode, name: r.name, cause: r.cause, ms: [], n: 0 };
    g.n++;
    if (r.ms !== null) g.ms.push(r.ms);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ ms, ...g }) => {
      ms.sort((a, b) => a - b);
      return { ...g, p50Ms: percentile(ms, 50), p90Ms: percentile(ms, 90) };
    })
    .sort((a, b) => `${a.mode}${a.name}${a.cause}`.localeCompare(`${b.mode}${b.name}${b.cause}`));
}

/** UTC day string, `YYYY-MM-DD`. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Start of the UTC day `ms` falls in. */
export const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** ISO 8601 week, `YYYY-Www`. */
export function isoWeek(ms: number): string {
  const d = new Date(dayStart(ms));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // the Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

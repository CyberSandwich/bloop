// Pure formatting for the IT export (SITE-06): CSV with formula-injection protection, and the column sets.
import type { AuditRow } from "./audit.ts";
import type { MetricSummary } from "./metrics.ts";

/** A spreadsheet runs a cell that starts with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula starters get a leading apostrophe, then RFC 4180 quoting. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const csvLine = (cells: readonly (string | number | boolean | null | undefined)[]): string =>
  `${cells.map(csvCell).join(",")}\r\n`;

export const AUDIT_COLUMNS = [
  "id",
  "time",
  "session",
  "room",
  "mode",
  "kind",
  "actor",
  "type",
  "user",
  "file_name",
  "source",
  "purpose",
  "cause",
  "reason",
  "bytes",
  "ip_match",
  "method",
  "client",
  "count",
] as const;

/** One flat record per audit row; the same keys head the CSV and name the JSON fields. */
export function auditRecord(r: AuditRow): Record<(typeof AUDIT_COLUMNS)[number], string | number | boolean | null> {
  const d = r.detail;
  return {
    id: r.id,
    time: new Date(r.at).toISOString(),
    session: r.sessionId,
    room: r.roomName,
    mode: r.mode,
    kind: r.kind,
    actor: r.actor,
    type: r.type,
    user: r.userEmail,
    file_name: d.fileName ?? null,
    source: d.source ?? null,
    purpose: d.purpose ?? null,
    cause: d.cause ?? null,
    reason: d.reason ?? null,
    bytes: d.bytes ?? null,
    ip_match: d.ipMatch ?? null,
    method: d.method ?? null,
    client: d.client ?? null,
    count: d.count ?? null,
  };
}

export const auditCsvHeader = (): string => csvLine(AUDIT_COLUMNS);
export const auditCsvLine = (r: AuditRow): string => csvLine(Object.values(auditRecord(r)));

export const METRIC_COLUMNS = ["mode", "name", "cause", "n", "p50_ms", "p90_ms"] as const;
export const metricRecord = (s: MetricSummary) => ({
  mode: s.mode,
  name: s.name,
  cause: s.cause,
  n: s.n,
  p50_ms: s.p50Ms,
  p90_ms: s.p90Ms,
});
export const metricsCsv = (rows: readonly MetricSummary[]): string =>
  csvLine(METRIC_COLUMNS) + rows.map((s) => csvLine(Object.values(metricRecord(s)))).join("");

/** A `YYYY-MM-DD` UTC date as the start of that day in ms, or null when it is not a real date. */
export function parseDay(text: string | null): number | null {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text ? null : ms;
}

const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

/** `from` and `to` are inclusive days; the result is the half-open `[from, to)` in ms. Null when invalid. */
export function exportRange(
  from: string | null,
  to: string | null,
  now: number,
): { from: number; to: number; label: string } | null {
  const end = to === null ? Math.floor(now / DAY_MS) * DAY_MS + DAY_MS : parseDay(to);
  if (end === null) return null;
  const endExclusive = to === null ? end : end + DAY_MS;
  const start = from === null ? endExclusive - DEFAULT_RANGE_DAYS * DAY_MS : parseDay(from);
  if (start === null || start >= endExclusive || endExclusive - start > MAX_RANGE_DAYS * DAY_MS) return null;
  const label = `${new Date(start).toISOString().slice(0, 10)}..${new Date(endExclusive - DAY_MS).toISOString().slice(0, 10)}`;
  return { from: start, to: endExclusive, label };
}

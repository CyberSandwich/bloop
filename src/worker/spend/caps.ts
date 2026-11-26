// Every cap, pool size and breaker threshold in one place, each with a default, a Worker var that can lower or raise
// it at deploy time, and the reason for the number. docs/spend.md lists them; test/unit/spend-caps.test.ts pins each.
// None of these vars is in wrangler.jsonc: the default below is the value until a deploy sets the var. config/spend.ts
// declares one optional var per entry, generated from these registries.

import type { SettingsSnapshot, SwitchName } from "./switches.ts";

export type Period = "hour" | "day" | "month";

export interface NumberSpec {
  readonly var: string;
  readonly default: number;
  readonly reason: string;
  /** A zero or negative var would turn a line into zero (an instant trip) or divide by it: the default is used. */
  readonly positive?: true;
  /** A deploy-time floor: a var below it fails the config. A row in /admin may still lower the cap at runtime, and a
   * job whose deadline then exceeds it is refused at admission as too_large, so only the deploy is guarded. */
  readonly min?: number;
}

const GIB = 1024 ** 3;

/** The longest job's stage timeouts plus transfers (container/README.md "Stages and timeouts"); a shorter lease would
 * expire under a job that is still inside its own limits. test/unit/convert-lease-guard.test.ts pins it. */
export const CONVERT_LEASE_FLOOR_SECONDS = 1770;

/** Hard ceilings the guard refuses past. A row `cap.<name>` in /admin can only lower one (the var is the maximum). */
export const CAPS = {
  pool_convert: { var: "CAP_POOL_CONVERT", default: 3, reason: "account conversions at once; a lecture-hour peak" },
  pool_convert_public: {
    var: "CAP_POOL_CONVERT_PUBLIC",
    default: 1,
    reason: "guest and demo conversions at once, so the public cannot starve accounts",
  },
  pool_export: {
    var: "CAP_POOL_EXPORT",
    default: 4,
    reason: "exports at once account-wide; each streams a library in Worker CPU",
  },
  pool_export_per_scope: { var: "CAP_POOL_EXPORT_PER_USER", default: 1, reason: "one export at a time per user" },
  lease_max_convert_seconds: {
    var: "CAP_LEASE_CONVERT_SECONDS",
    default: 1800,
    min: CONVERT_LEASE_FLOOR_SECONDS,
    reason:
      "longest a conversion lease may be asked for: the longest chain is a video's, inspect 30 s plus the video stage's 1440 s plus 300 s for the transfers, 1770 s (test/unit/container-lease.test.ts holds every kind under it)",
  },
  lease_max_export_seconds: {
    var: "CAP_LEASE_EXPORT_SECONDS",
    default: 900,
    reason: "longest an export lease may be asked for",
  },
  lease_grace_seconds: {
    var: "CAP_LEASE_GRACE_SECONDS",
    default: 300,
    reason:
      "an unreleased lease keeps its slot this long past its deadline (the Converter destroys the container at the deadline), then is dropped and counted overdue",
  },
  container_seconds_day: {
    var: "CAP_CONTAINER_SECONDS_DAY",
    default: 21600,
    reason: "6 instance-hours a day: at most about $0.77 a day on standard-2",
  },
  convert_user_day: {
    var: "CAP_CONVERT_USER_DAY",
    default: 20,
    reason: "conversions per account per day; a heavy day is 5 to 10 decks",
  },
  convert_guest_ip_day: {
    var: "CAP_CONVERT_GUEST_IP_DAY",
    default: 10,
    reason: "guest conversions per IP hash per day",
  },
  convert_demo_day: { var: "CAP_CONVERT_DEMO_DAY", default: 200, reason: "demo conversions per day, all visitors" },
  convert_demo_ip_day: { var: "CAP_CONVERT_DEMO_IP_DAY", default: 10, reason: "demo conversions per IP hash per day" },
  r2_class_a_month: {
    var: "CAP_R2_CLASS_A_MONTH",
    default: 1_500_000,
    reason: "class A operations per UTC month: 0.5M over the free 1M costs $2.25",
  },
  r2_class_b_month: {
    var: "CAP_R2_CLASS_B_MONTH",
    default: 15_000_000,
    reason: "class B operations per UTC month: 5M over the free 10M costs $1.80",
  },
  upload_user_day: { var: "CAP_UPLOAD_USER_DAY", default: 50, reason: "library uploads per account per day" },
  upload_user_bytes_day: {
    var: "CAP_UPLOAD_USER_BYTES_DAY",
    default: 10 * GIB,
    reason: "bytes uploaded per account per day; a purge does not give them back, so upload, purge, repeat is bounded",
  },
  guest_drop_ip_day: {
    var: "CAP_GUEST_DROP_IP_DAY",
    default: 20,
    reason: "guest drops per IP hash per day; a busy seminar behind one NAT",
  },
  email_hour: { var: "CAP_EMAIL_HOUR", default: 60, reason: "sends per hour account-wide" },
  email_day: {
    var: "CAP_EMAIL_DAY",
    default: 180,
    reason:
      "sends per day account-wide; platform quota 200/day until raised; raise this cap only after Cloudflare raises the quota",
  },
  email_code_ip_day: { var: "CAP_EMAIL_CODE_IP_DAY", default: 20, reason: "sign-in code requests per IP hash per day" },
  export_user_day: { var: "CAP_EXPORT_USER_DAY", default: 3, reason: "exports per account per day" },
  demo_session_day: { var: "CAP_DEMO_SESSION_DAY", default: 2000, reason: "demo sessions per day, all visitors" },
  r2_block_ops: {
    var: "CAP_R2_BLOCK_OPS",
    default: 100,
    reason:
      "R2 operations of one class an isolate reserves from the guard at a time and spends locally; leftovers are never returned, so the count errs high",
  },
  isolate_open_email_day: {
    var: "CAP_ISOLATE_OPEN_EMAIL_DAY",
    default: 20,
    reason: "sends per day one Worker isolate allows while the guard is unreachable (email fails open, bounded here)",
  },
  isolate_open_email_code_ip_day: {
    var: "CAP_ISOLATE_OPEN_EMAIL_CODE_IP_DAY",
    default: 10,
    reason: "code requests per IP hash per day one isolate allows while the guard is unreachable",
  },
  isolate_open_demo_session_day: {
    var: "CAP_ISOLATE_OPEN_DEMO_SESSION_DAY",
    default: 200,
    reason:
      "demo sessions per day one isolate allows while the guard is unreachable (the demo fails open, bounded here)",
  },
} as const satisfies Record<string, NumberSpec>;

/** Breaker lines. Raising one needs a deploy; there is no row for them. */
export const TRIPS = {
  trip_pct: {
    var: "BREAKER_TRIP_PCT",
    default: 100,
    reason: "a capped daily meter at this percent of its cap trips its switch",
  },
  warn_pct: {
    var: "BREAKER_WARN_PCT",
    default: 50,
    reason: "a capped daily meter at this percent of its cap sends a warning",
  },
  month_warn_pct: {
    var: "BREAKER_MONTH_WARN_PCT",
    default: 80,
    reason: "a monthly meter at this percent of its cap sends a warning",
  },
  convert_failed_pct: {
    var: "BREAKER_CONVERT_FAILED_PCT",
    default: 20,
    reason: "failed conversions as a percent of the day's: a poison flood",
  },
  convert_failed_min: {
    var: "BREAKER_CONVERT_FAILED_MIN",
    default: 10,
    reason: "conversions needed in a day before the failure percent counts",
  },
  guest_drop_cost_usd: {
    var: "BREAKER_GUEST_DROP_COST_USD",
    default: 0.00002,
    positive: true,
    reason:
      "cost of one guest drop that is not converted: 3 R2 class A, 3 class B and 5 D1 rows, $0.0000194, rounded up",
  },
  guest_drops_demo_off_pct: {
    var: "BREAKER_GUEST_DROPS_DEMO_OFF_PCT",
    default: 5,
    reason: "percent of the monthly budget, spent in one day by guest drops, that turns demo drop off",
  },
  guest_drops_files_stopped_pct: {
    var: "BREAKER_GUEST_DROPS_FILES_STOPPED_PCT",
    default: 15,
    reason: "percent of the monthly budget, spent in one day by guest drops, that stops guest files",
  },
  budget_month_usd: {
    var: "BREAKER_BUDGET_MONTH_USD",
    default: 10,
    positive: true,
    reason:
      "estimated month-to-date cost of everything without a platform cap: at this the breaker flips every costly switch",
  },
  k: {
    var: "BREAKER_K",
    default: 3,
    reason: "a daily trip line follows this multiple of the trailing p95 of that meter's daily usage",
  },
  history_days: { var: "BREAKER_HISTORY_DAYS", default: 14, reason: "completed days the p95 is taken over" },
  history_min_days: {
    var: "BREAKER_HISTORY_MIN_DAYS",
    default: 7,
    reason: "completed days of history needed before the p95 counts; fewer and the floor is the line",
  },
  ceiling_multiple: {
    var: "BREAKER_CEILING_MULTIPLE",
    default: 5,
    reason: "default ceiling of a trip line as a multiple of its floor; only the owner raises it",
  },
  line_growth_multiple: {
    var: "BREAKER_LINE_GROWTH_MULTIPLE",
    default: 2,
    positive: true,
    reason: "a trip line rises at most this multiple of the day before's line, so one abuse day cannot jump it",
  },
  ceiling_watch_pct: {
    var: "BREAKER_CEILING_WATCH_PCT",
    default: 70,
    reason: "a meter whose p95 reaches this percent of its ceiling is flagged in the weekly digest",
  },
  gauge_share_storage_pct: {
    var: "BREAKER_SHARE_R2_STORAGE",
    default: 5,
    reason: "share of the monthly budget for R2 storage (a gauge, not a daily meter): warn only",
  },
  share_logs_pct: {
    var: "BREAKER_SHARE_LOGS",
    default: 10,
    reason: "share of the monthly budget set aside for log ingest, which has no meter yet",
  },
  workers_requests_day_warn: {
    var: "BREAKER_WORKERS_REQ_DAY_WARN",
    default: 1_000_000,
    reason: "Worker requests in a day: warn",
  },
  workers_spike_multiple: {
    var: "BREAKER_WORKERS_SPIKE_MULTIPLE",
    default: 3,
    reason: "Worker requests in a day over this multiple of the trailing 7-day mean: warn",
  },
  workers_spike_floor: {
    var: "BREAKER_WORKERS_SPIKE_FLOOR",
    default: 50_000,
    reason: "a spike must also pass this many requests, so a quiet week does not alarm on small numbers",
  },
  do_requests_day_warn: {
    var: "BREAKER_DO_REQ_DAY_WARN",
    default: 150_000,
    reason: "Durable Object requests in a day: warn",
  },
  do_gb_seconds_day_warn: {
    var: "BREAKER_DO_GBS_DAY_WARN",
    default: 30_000,
    reason: "Durable Object duration in GB-seconds in a day: warn",
  },
  analytics_fail_runs: {
    var: "BREAKER_ANALYTICS_FAIL_RUNS",
    default: 3,
    reason: "consecutive runs with a failed analytics read before one alert",
  },
} as const satisfies Record<string, NumberSpec>;

export type CapName = keyof typeof CAPS;
export type TripName = keyof typeof TRIPS;
export type Caps = Record<CapName, number>;
export type Trips = Record<TripName, number>;

type Vars = Readonly<Record<string, unknown>>;

/** A var that is a finite number of at least 0, or undefined. */
function numberVar(vars: Vars, name: string): number | undefined {
  const raw = vars[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const rejected = new Set<string>();

/** Like `numberVar` but above zero; a var that is set and not above zero is logged once and ignored. */
function positiveVar(vars: Vars, name: string): number | undefined {
  const n = numberVar(vars, name);
  if (n === undefined || n > 0) return n;
  if (!rejected.has(name)) {
    rejected.add(name);
    console.error(JSON.stringify({ evt: "spend_var_rejected", var: name, why: "must be greater than 0" }));
  }
  return undefined;
}

/** The var when it is a valid number, else the default. A garbage var must not open or close a cap by accident. */
export function resolveTrips(vars: Vars): Trips {
  const out = {} as Trips;
  for (const [name, s] of Object.entries(TRIPS) as [TripName, NumberSpec][])
    out[name] = (s.positive ? positiveVar(vars, s.var) : numberVar(vars, s.var)) ?? s.default;
  return out;
}

/** The var (or default) as the maximum, lowered by a row override when one is set. */
export function resolveCaps(vars: Vars, overrides: Readonly<Partial<Record<CapName, number>>> = {}): Caps {
  const out = {} as Caps;
  for (const [name, s] of Object.entries(CAPS) as [CapName, NumberSpec][]) {
    const ceiling = numberVar(vars, s.var) ?? s.default;
    const override = overrides[name];
    out[name] =
      override !== undefined && Number.isFinite(override) && override >= 0 ? Math.min(ceiling, override) : ceiling;
  }
  return out;
}

/** The `cap.<name>` rows of a settings snapshot as numbers: only known caps, only finite values of at least 0. */
export function capOverridesOf(settings: SettingsSnapshot): Partial<Record<CapName, number>> {
  const out: Partial<Record<CapName, number>> = {};
  for (const name of Object.keys(CAPS) as CapName[]) {
    const raw = settings[`cap.${name}`];
    const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0) out[name] = n;
  }
  return out;
}

export interface Limit {
  readonly period: Period;
  readonly cap: CapName;
}
export interface MeterDef {
  /** Checked against the all-scopes counter. */
  readonly global?: readonly Limit[];
  /** Checked against the counter of the scope the caller names (user id, IP hash). */
  readonly perScope?: readonly Limit[];
}

const day = (cap: CapName): Limit => ({ period: "day", cap });

/**
 * Every counter the guard keeps. A scoped meter also keeps its all-scopes counter, which is what the breaker reads.
 * A meter with no limits only counts.
 */
export const METERS = {
  container_seconds: { global: [day("container_seconds_day")] },
  convert_user: { perScope: [day("convert_user_day")] },
  convert_guest: { perScope: [day("convert_guest_ip_day")] },
  convert_demo: { global: [day("convert_demo_day")], perScope: [day("convert_demo_ip_day")] },
  conversion_done: {},
  conversion_failed: {},
  r2_class_a: { global: [{ period: "month", cap: "r2_class_a_month" }] },
  r2_class_b: { global: [{ period: "month", cap: "r2_class_b_month" }] },
  upload_user: { perScope: [day("upload_user_day")] },
  upload_user_bytes: { perScope: [day("upload_user_bytes_day")] },
  guest_drop: { perScope: [day("guest_drop_ip_day")] },
  email: { global: [{ period: "hour", cap: "email_hour" }, day("email_day")] },
  email_code: { perScope: [day("email_code_ip_day")] },
  export_user: { perScope: [day("export_user_day")] },
  demo_session: { global: [day("demo_session_day")] },
  // Read from analytics only: no caller records it, so without CF_ANALYTICS_TOKEN its line cannot trip.
  d1_writes: {},
} as const satisfies Record<string, MeterDef>;

export type MeterName = keyof typeof METERS;
export const isMeter = (name: string): name is MeterName => Object.hasOwn(METERS, name);
/** The meters whose take hands back a refund ticket: the work a caller can start and then not do. */
export const REFUNDABLE_METERS = ["container_seconds", "upload_user", "upload_user_bytes"] as const;
export type RefundableMeter = (typeof REFUNDABLE_METERS)[number];
export const isRefundable = (name: MeterName): name is RefundableMeter =>
  (REFUNDABLE_METERS as readonly string[]).includes(name);
/** A meter with a per-scope limit: its calls must name a scope. */
export const isScoped = (name: MeterName): boolean => ((METERS[name] as MeterDef).perScope?.length ?? 0) > 0;

export interface PoolDef {
  readonly cap: CapName;
  readonly perScopeCap?: CapName;
  readonly maxSeconds: CapName;
}

export const POOLS = {
  convert: { cap: "pool_convert", maxSeconds: "lease_max_convert_seconds" },
  convert_public: { cap: "pool_convert_public", maxSeconds: "lease_max_convert_seconds" },
  export: { cap: "pool_export", perScopeCap: "pool_export_per_scope", maxSeconds: "lease_max_export_seconds" },
} as const satisfies Record<string, PoolDef>;

export type PoolName = keyof typeof POOLS;
export const isPool = (name: string): name is PoolName => Object.hasOwn(POOLS, name);

/** Counter periods are UTC; each key sorts in time order. */
export function periodKey(period: Period, at: number): string {
  const iso = new Date(at).toISOString();
  return period === "hour" ? `h${iso.slice(0, 13)}` : period === "day" ? `d${iso.slice(0, 10)}` : `m${iso.slice(0, 7)}`;
}

/** Milliseconds from `at` to the start of the next period. */
export function msToPeriodEnd(period: Period, at: number): number {
  const d = new Date(at);
  const next =
    period === "hour"
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
      : period === "day"
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
        : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return next - at;
}

// The money side: a monthly budget split across the meters that have no platform spend limit, each priced per unit.
// Prices are the overage rates of the v4 cost plan (kept outside the repo), with free allowances NOT subtracted, so
// the estimate and the lines err toward tripping early. docs/spend.md shows the arithmetic.

export interface Priced {
  readonly label: string;
  readonly unit: string;
  /** Overage price of one unit, USD. container_seconds is standard-2 at full CPU, the upper bound. */
  readonly unitUsd: number;
  /** Percent of the monthly budget; the shares of all rows plus storage and logs add to 100. */
  readonly share: { readonly var: string; readonly default: number };
  /** Optional absolute replacements for the derived floor and the default ceiling (units per day). */
  readonly floorVar: string;
  readonly ceilingVar: string;
  /** A daily hard cap on the same unit: the default ceiling never exceeds it, so the line and the cap agree. */
  readonly capDay?: CapName;
  /** Tripped when the day's usage reaches the line. */
  readonly flip: { readonly switch: SwitchName; readonly value: string };
}

export const PRICED = {
  container_seconds: {
    label: "Containers",
    unit: "instance-seconds",
    unitUsd: 0.0000358,
    share: { var: "BREAKER_SHARE_CONTAINERS", default: 45 },
    floorVar: "BREAKER_FLOOR_CONTAINERS",
    ceilingVar: "BREAKER_CEILING_CONTAINERS",
    flip: { switch: "convert", value: "off" },
  },
  r2_class_a: {
    label: "R2 class A",
    unit: "operations",
    unitUsd: 0.0000045,
    share: { var: "BREAKER_SHARE_R2_CLASS_A", default: 15 },
    floorVar: "BREAKER_FLOOR_R2_CLASS_A",
    ceilingVar: "BREAKER_CEILING_R2_CLASS_A",
    flip: { switch: "uploads", value: "readonly" },
  },
  r2_class_b: {
    label: "R2 class B",
    unit: "operations",
    unitUsd: 0.00000036,
    share: { var: "BREAKER_SHARE_R2_CLASS_B", default: 5 },
    floorVar: "BREAKER_FLOOR_R2_CLASS_B",
    ceilingVar: "BREAKER_CEILING_R2_CLASS_B",
    flip: { switch: "previews", value: "off" },
  },
  d1_writes: {
    label: "D1 writes",
    unit: "rows",
    unitUsd: 0.000001,
    share: { var: "BREAKER_SHARE_D1", default: 10 },
    floorVar: "BREAKER_FLOOR_D1",
    ceilingVar: "BREAKER_CEILING_D1",
    flip: { switch: "demo", value: "off" },
  },
  email: {
    label: "Email",
    unit: "sends",
    unitUsd: 0.00035,
    share: { var: "BREAKER_SHARE_EMAIL", default: 10 },
    floorVar: "BREAKER_FLOOR_EMAIL",
    ceilingVar: "BREAKER_CEILING_EMAIL",
    capDay: "email_day",
    flip: { switch: "email", value: "admin_only" },
  },
} as const satisfies Record<string, Priced>;

export type PricedMeter = keyof typeof PRICED;
export const PRICED_METERS = Object.keys(PRICED) as PricedMeter[];

/** R2 storage is billed per GB-month; it is a gauge with a warning line, not a daily meter. */
export const R2_STORAGE_USD_PER_GB = 0.015;
/** Workers and Durable Objects have platform spend limits; their usage is priced only to suggest those limits. */
export const PLATFORM_USD = { workersPerMillion: 0.3, doRequestsPerMillion: 0.15, doGbSecondsPerMillion: 12.5 };

/** What the month-to-date total stop flips: every switch whose feature costs money. */
export const COSTLY_FLIPS: readonly { readonly switch: SwitchName; readonly value: string }[] = [
  { switch: "convert", value: "off" },
  { switch: "uploads", value: "readonly" },
  { switch: "demo_drop", value: "off" },
  { switch: "guest_drop", value: "off" },
  { switch: "email", value: "admin_only" },
  { switch: "export", value: "off" },
  { switch: "previews", value: "off" },
];

export interface Line {
  readonly floor: number;
  readonly ceiling: number;
}

/**
 * Per-day floor and ceiling of each priced meter. The floor is the meter's share of budget / 30 days, in units
 * (or its var); the ceiling is its var, or `ceiling_multiple` times the floor (at most the meter's daily cap, when it
 * has one), and never below the floor.
 */
export function resolveLines(vars: Vars, trips: Trips, caps: Caps = resolveCaps(vars)): Record<PricedMeter, Line> {
  const out = {} as Record<PricedMeter, Line>;
  for (const m of PRICED_METERS) {
    const p: Priced = PRICED[m];
    const share = positiveVar(vars, p.share.var) ?? p.share.default;
    const floor =
      positiveVar(vars, p.floorVar) ?? Math.round(((share / 100) * trips.budget_month_usd) / 30 / p.unitUsd);
    const byMultiple = floor * trips.ceiling_multiple;
    const ceiling = positiveVar(vars, p.ceilingVar) ?? (p.capDay ? Math.min(byMultiple, caps[p.capDay]) : byMultiple);
    out[m] = { floor, ceiling: Math.max(floor, ceiling) };
  }
  return out;
}

/**
 * Guest drops a day at which demo drop turns off, and at which guest files stop: the day's spend by drops alone
 * (`guest_drop_cost_usd` each) as a share of the budget over 30 days. They overlap the R2 and D1 lines above.
 */
export function guestDropLines(t: Trips): { demoOff: number; filesStopped: number } {
  const perDay = (pct: number) => Math.round(((pct / 100) * t.budget_month_usd) / 30 / t.guest_drop_cost_usd);
  return { demoOff: perDay(t.guest_drops_demo_off_pct), filesStopped: perDay(t.guest_drops_files_stopped_pct) };
}

/** Nearest-rank 95th percentile; 0 for no values. */
export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] as number;
}

/**
 * Today's trip line from the completed days, newest first. Each day's line is k times the p95 of the `history_days`
 * ending at the day before, clamped to [floor, ceiling], and at most `line_growth_multiple` times the line the day
 * before (never under the floor), so one abuse day cannot lift it past a step. With fewer than `history_min_days`
 * days behind it the p95 is not trusted and that day's line is the floor.
 */
export function tripLine(
  line: Line,
  completed: readonly number[],
  t: Pick<Trips, "k" | "history_days" | "history_min_days" | "line_growth_multiple">,
): number {
  let day = line.floor;
  for (let i = completed.length - 1; i >= 0; i--) {
    const window = completed.slice(i, i + t.history_days);
    if (window.length < t.history_min_days) {
      day = line.floor;
      continue;
    }
    const wanted = Math.min(line.ceiling, Math.max(line.floor, t.k * p95(window)));
    day = Math.min(wanted, Math.max(line.floor, day * t.line_growth_multiple));
  }
  return day;
}

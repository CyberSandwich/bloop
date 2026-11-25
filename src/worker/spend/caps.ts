// Every cap, pool size and breaker threshold in one place, each with a default, a Worker var that can lower or raise
// it at deploy time, and the reason for the number. docs/spend.md lists them; test/unit/spend-caps.test.ts pins each.
// None of these vars is in config.ts or wrangler.jsonc: the default below is the value until a deploy sets the var.

export type Period = "hour" | "day" | "month";

export interface NumberSpec {
  readonly var: string;
  readonly default: number;
  readonly reason: string;
}

const GIB = 1024 ** 3;

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
    reason: "longest a conversion lease may be asked for: the stage timeouts add to about 22 minutes",
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
  email_day: { var: "CAP_EMAIL_DAY", default: 300, reason: "sends per day account-wide; 1,000 users need about 170" },
  email_recipient_day: { var: "CAP_EMAIL_RECIPIENT_DAY", default: 10, reason: "sends per recipient per day" },
  email_code_ip_day: { var: "CAP_EMAIL_CODE_IP_DAY", default: 20, reason: "sign-in code requests per IP hash per day" },
  export_user_day: { var: "CAP_EXPORT_USER_DAY", default: 3, reason: "exports per account per day" },
  demo_session_day: { var: "CAP_DEMO_SESSION_DAY", default: 2000, reason: "demo sessions per day, all visitors" },
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
  leases_live_max: {
    var: "BREAKER_LEASES_LIVE_MAX",
    default: 4,
    reason: "more live conversion leases than the pools allow together means a leak: convert off",
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
  guest_drops_demo_off_day: {
    var: "BREAKER_GUEST_DROPS_DEMO_OFF_DAY",
    default: 1000,
    reason: "guest drops in a day, all IPs: demo drop off",
  },
  guest_drops_files_stopped_day: {
    var: "BREAKER_GUEST_DROPS_FILES_STOPPED_DAY",
    default: 3000,
    reason: "guest drops in a day, all IPs: guest files stopped",
  },
  r2_class_a_day_warn: { var: "BREAKER_R2_A_DAY_WARN", default: 50_000, reason: "class A operations in a day: warn" },
  r2_class_a_day_trip: {
    var: "BREAKER_R2_A_DAY_TRIP",
    default: 250_000,
    reason:
      "class A operations in a day, counted or from analytics (presigned PUTs are not counted in the Worker): uploads read-only",
  },
  r2_class_b_day_warn: { var: "BREAKER_R2_B_DAY_WARN", default: 500_000, reason: "class B operations in a day: warn" },
  r2_storage_bytes_warn: {
    var: "BREAKER_R2_STORAGE_BYTES_WARN",
    default: 100_000_000_000,
    reason: "R2 bytes stored: warn; raise with users",
  },
  d1_rows_day_warn: { var: "BREAKER_D1_ROWS_DAY_WARN", default: 1_500_000, reason: "D1 rows written in a day: warn" },
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

/** The var when it is a valid number, else the default. A garbage var must not open or close a cap by accident. */
export function resolveTrips(vars: Vars): Trips {
  const out = {} as Trips;
  for (const [name, s] of Object.entries(TRIPS) as [TripName, NumberSpec][])
    out[name] = numberVar(vars, s.var) ?? s.default;
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

export interface Limit {
  readonly period: Period;
  readonly cap: CapName;
}
export interface MeterDef {
  /** Checked against the all-scopes counter. */
  readonly global?: readonly Limit[];
  /** Checked against the counter of the scope the caller names (user id, IP hash, recipient hash). */
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
  email_recipient: { perScope: [day("email_recipient_day")] },
  email_code: { perScope: [day("email_code_ip_day")] },
  export_user: { perScope: [day("export_user_day")] },
  demo_session: { global: [day("demo_session_day")] },
  d1_writes: {},
} as const satisfies Record<string, MeterDef>;

export type MeterName = keyof typeof METERS;
export const isMeter = (name: string): name is MeterName => Object.hasOwn(METERS, name);

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

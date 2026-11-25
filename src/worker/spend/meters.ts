// The SpendGuard's logic over a SqlLike, so unit tests run it on node:sqlite (like demo-slots.ts) and the Durable
// Object only adds the clock. Every method is synchronous: a check and the write it allows run with no await
// between them, which is what makes a cap exact under concurrent callers.
import type { SqlLike } from "../do/demo-slots.ts";
import {
  type Caps,
  isMeter,
  isPool,
  type Limit,
  METERS,
  type MeterDef,
  type MeterName,
  msToPeriodEnd,
  type Period,
  POOLS,
  type PoolName,
  periodKey,
} from "./caps.ts";
import { isStricter, type SwitchName } from "./switches.ts";

const SCHEMA_STEPS = [
  `CREATE TABLE counter (meter TEXT NOT NULL, scope TEXT NOT NULL, period TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (meter, scope, period)) WITHOUT ROWID;
   CREATE TABLE lease (id TEXT PRIMARY KEY, pool TEXT NOT NULL, scope TEXT NOT NULL, acquired_at INTEGER NOT NULL, deadline INTEGER NOT NULL);
   CREATE TABLE trip (switch TEXT PRIMARY KEY, value TEXT NOT NULL, tripped_at INTEGER NOT NULL, reason TEXT NOT NULL, reading TEXT NOT NULL, alerted INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE alert (key TEXT PRIMARY KEY, day TEXT NOT NULL);
   CREATE TABLE override (name TEXT PRIMARY KEY, value REAL NOT NULL);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`,
];

/** The all-scopes counter row's scope. A real scope is an id or a hash and never empty. */
const ALL = "";
/** Counter name the breaker reads for leases dropped past their grace. */
const OVERDUE_METER = "lease_overdue";

export type TakeRefusal = {
  ok: false;
  reason: "cap_hit";
  meter: MeterName;
  period: Period;
  /** Whether the all-scopes counter or the caller's own scope hit it. */
  scope: "all" | "own";
  retryAfterSeconds: number;
};
export type TakeResult = { ok: true } | TakeRefusal;
export type AcquireResult =
  | { ok: true; leaseId: string; deadline: number }
  | { ok: false; reason: "busy"; retryAfterSeconds: number };

export interface PeriodCounts {
  hour: number;
  day: number;
  month: number;
}
export interface PoolGauge {
  live: number;
  /** Held past the deadline, inside the grace. */
  overdue: number;
}
export interface TripRow {
  switch: SwitchName;
  value: string;
  trippedAt: number;
  reason: string;
  reading: string;
  alerted: boolean;
}
export interface Snapshot {
  at: number;
  /** The caps in force (var or default, lowered by any override). */
  caps: Caps;
  /** Current-period, all-scopes counts for every meter. */
  counters: Record<MeterName, PeriodCounts>;
  pools: Record<PoolName, PoolGauge>;
  /** Leases dropped past their grace today: a Converter that did not destroy its container. */
  leasesDroppedToday: number;
  trips: TripRow[];
}

const positiveInt = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${what} must be a positive integer`);
  return n;
};
const retrySeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export class Ledger {
  constructor(private readonly sql: SqlLike) {
    this.migrate();
  }

  // One numbered step per schema change, checked on every wake (CLAUDE.md, Durable Object schema).
  private migrate(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    );
    let version = Number(this.sql.exec("SELECT version FROM schema_version WHERE id = 1").toArray()[0]?.version ?? 0);
    for (; version < SCHEMA_STEPS.length; version++) {
      this.sql.exec(SCHEMA_STEPS[version] as string);
      this.sql.exec("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)", version + 1);
    }
  }

  private get(meter: string, scope: string, period: string): number {
    const row = this.sql
      .exec("SELECT n FROM counter WHERE meter = ? AND scope = ? AND period = ?", meter, scope, period)
      .toArray()[0];
    return Number(row?.n ?? 0);
  }

  private add(meter: string, scope: string, period: string, delta: number): void {
    this.sql.exec(
      "INSERT INTO counter (meter, scope, period, n) VALUES (?, ?, ?, MAX(?, 0)) ON CONFLICT (meter, scope, period) DO UPDATE SET n = MAX(n + ?, 0)",
      meter,
      scope,
      period,
      delta,
      delta,
    );
  }

  /** The periods a meter keeps: those its limits use, and always the day (the breaker reads it). */
  private periods(meter: MeterName): Period[] {
    const def: MeterDef = METERS[meter];
    const set = new Set<Period>(["day"]);
    for (const l of [...(def.global ?? []), ...(def.perScope ?? [])]) set.add(l.period);
    return [...set];
  }

  private scoped(meter: MeterName): boolean {
    const def: MeterDef = METERS[meter];
    return (def.perScope?.length ?? 0) > 0;
  }

  private rows(meter: MeterName, scope: string | undefined, at: number): [string, string][] {
    const out: [string, string][] = [];
    const own = this.scoped(meter) ? scope : undefined;
    for (const p of this.periods(meter)) {
      const key = periodKey(p, at);
      out.push([ALL, key]);
      if (own) out.push([own, key]);
    }
    return out;
  }

  /**
   * Adds `n` to a meter if no cap would be passed; otherwise adds nothing and says which cap and when to retry.
   * A scoped meter needs a scope (throws without one: a missing scope would skip the per-user cap).
   */
  take(meter: MeterName, n: number, scope: string | undefined, caps: Caps, now: number): TakeResult {
    positiveInt(n, "n");
    if (!isMeter(meter)) throw new RangeError(`unknown meter ${meter}`);
    if (this.scoped(meter) && !scope) throw new RangeError(`meter ${meter} needs a scope`);
    const def: MeterDef = METERS[meter];
    let worst: TakeRefusal | undefined;
    const check = (limits: readonly Limit[] | undefined, which: "all" | "own") => {
      for (const l of limits ?? []) {
        const used = this.get(meter, which === "all" ? ALL : (scope as string), periodKey(l.period, now));
        if (used + n <= caps[l.cap]) continue;
        const wait = msToPeriodEnd(l.period, now);
        if (!worst || wait > worst.retryAfterSeconds * 1000)
          worst = {
            ok: false,
            reason: "cap_hit",
            meter,
            period: l.period,
            scope: which,
            retryAfterSeconds: retrySeconds(wait),
          };
      }
    };
    check(def.global, "all");
    check(def.perScope, "own");
    if (worst) return worst;
    for (const [s, p] of this.rows(meter, scope, now)) this.add(meter, s, p, n);
    return { ok: true };
  }

  /** Counts without checking any cap: events that already happened (a failure, a finished job). */
  record(meter: MeterName, n: number, scope: string | undefined, now: number): void {
    positiveInt(n, "n");
    if (!isMeter(meter)) throw new RangeError(`unknown meter ${meter}`);
    for (const [s, p] of this.rows(meter, scope, now)) this.add(meter, s, p, n);
  }

  /** Gives back part of an earlier take; `at` is when it was taken, so a midnight crossing refunds the right day. */
  refund(meter: MeterName, n: number, scope: string | undefined, at: number): void {
    positiveInt(n, "n");
    if (!isMeter(meter)) throw new RangeError(`unknown meter ${meter}`);
    for (const [s, p] of this.rows(meter, scope, at)) this.add(meter, s, p, -n);
  }

  /** Takes a pool slot for at most `ttlSeconds` (clamped to the pool's maximum). Busy, with nothing held, when full. */
  acquire(pool: PoolName, scope: string | undefined, ttlSeconds: number, caps: Caps, now: number): AcquireResult {
    if (!isPool(pool)) throw new RangeError(`unknown pool ${pool}`);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new RangeError("ttlSeconds must be positive");
    const def = POOLS[pool];
    this.dropLapsed(now, caps);
    const live = Number(this.sql.exec("SELECT count(*) AS n FROM lease WHERE pool = ?", pool).toArray()[0]?.n ?? 0);
    const own = scope
      ? Number(
          this.sql.exec("SELECT count(*) AS n FROM lease WHERE pool = ? AND scope = ?", pool, scope).toArray()[0]?.n ??
            0,
        )
      : 0;
    const perScopeCap = "perScopeCap" in def ? caps[def.perScopeCap] : Number.POSITIVE_INFINITY;
    if (live >= caps[def.cap] || own >= perScopeCap) {
      const soonest = Number(
        this.sql.exec("SELECT min(deadline) AS d FROM lease WHERE pool = ?", pool).toArray()[0]?.d ?? now + 30_000,
      );
      return { ok: false, reason: "busy", retryAfterSeconds: Math.min(60, retrySeconds(soonest - now)) };
    }
    const deadline = now + Math.min(ttlSeconds, caps[def.maxSeconds]) * 1000;
    const leaseId = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO lease (id, pool, scope, acquired_at, deadline) VALUES (?, ?, ?, ?, ?)",
      leaseId,
      pool,
      scope ?? ALL,
      now,
      deadline,
    );
    return { ok: true, leaseId, deadline };
  }

  /** True when the lease was held. Releasing twice, or after the grace dropped it, is harmless. */
  release(leaseId: string): boolean {
    const held = this.sql.exec("SELECT 1 AS one FROM lease WHERE id = ?", leaseId).toArray().length > 0;
    if (held) this.sql.exec("DELETE FROM lease WHERE id = ?", leaseId);
    return held;
  }

  /** Frees leases past deadline plus grace and counts each: its Converter never released it. */
  private dropLapsed(now: number, caps: Caps): void {
    const cutoff = now - caps.lease_grace_seconds * 1000;
    const lapsed = Number(
      this.sql.exec("SELECT count(*) AS n FROM lease WHERE deadline <= ?", cutoff).toArray()[0]?.n ?? 0,
    );
    if (lapsed === 0) return;
    this.sql.exec("DELETE FROM lease WHERE deadline <= ?", cutoff);
    this.add(OVERDUE_METER, ALL, periodKey("day", now), lapsed);
  }

  snapshot(now: number, caps: Caps): Snapshot {
    this.dropLapsed(now, caps);
    const counters = {} as Record<MeterName, PeriodCounts>;
    for (const meter of Object.keys(METERS) as MeterName[])
      counters[meter] = {
        hour: this.get(meter, ALL, periodKey("hour", now)),
        day: this.get(meter, ALL, periodKey("day", now)),
        month: this.get(meter, ALL, periodKey("month", now)),
      };
    const pools = {} as Record<PoolName, PoolGauge>;
    for (const pool of Object.keys(POOLS) as PoolName[]) {
      const row = this.sql
        .exec(
          "SELECT count(*) AS live, coalesce(sum(deadline <= ?), 0) AS overdue FROM lease WHERE pool = ?",
          now,
          pool,
        )
        .toArray()[0];
      pools[pool] = { live: Number(row?.live ?? 0), overdue: Number(row?.overdue ?? 0) };
    }
    return {
      at: now,
      caps,
      counters,
      pools,
      leasesDroppedToday: this.get(OVERDUE_METER, ALL, periodKey("day", now)),
      trips: this.trips(),
    };
  }

  /** Drops counters nobody reads: hours after 2 days, days after 40, months after 14. */
  prune(now: number): void {
    const keep: [Period, number][] = [
      ["hour", 2 * 86_400_000],
      ["day", 40 * 86_400_000],
      ["month", 430 * 86_400_000],
    ];
    for (const [p, age] of keep)
      this.sql.exec(
        "DELETE FROM counter WHERE substr(period, 1, 1) = ? AND period < ?",
        p[0] as string,
        periodKey(p, now - age),
      );
    this.sql.exec("DELETE FROM alert WHERE day < ?", periodKey("day", now - 2 * 86_400_000));
  }

  // Breaker state: latched until reset, one alert per trip.

  /** Latches a switch value. False (nothing changes) when the switch is already latched at this value or a stricter one. */
  latchTrip(name: SwitchName, value: string, reason: string, reading: string, now: number): boolean {
    const held = this.sql.exec("SELECT value FROM trip WHERE switch = ?", name).toArray()[0];
    if (held && !isStricter(name, value, String(held.value))) return false;
    this.sql.exec(
      "INSERT OR REPLACE INTO trip (switch, value, tripped_at, reason, reading, alerted) VALUES (?, ?, ?, ?, ?, 0)",
      name,
      value,
      now,
      reason,
      reading,
    );
    return true;
  }

  trips(): TripRow[] {
    return this.sql
      .exec("SELECT switch, value, tripped_at, reason, reading, alerted FROM trip ORDER BY tripped_at, switch")
      .toArray()
      .map((r) => ({
        switch: String(r.switch) as SwitchName,
        value: String(r.value),
        trippedAt: Number(r.tripped_at),
        reason: String(r.reason),
        reading: String(r.reading),
        alerted: Number(r.alerted) === 1,
      }));
  }

  /** Marks the alert for exactly this latched value sent; a later, stricter trip is a new alert. */
  markAlerted(name: SwitchName, value: string): void {
    this.sql.exec("UPDATE trip SET alerted = 1 WHERE switch = ? AND value = ?", name, value);
  }

  resetTrip(name: SwitchName): boolean {
    const held = this.sql.exec("SELECT 1 AS one FROM trip WHERE switch = ?", name).toArray().length > 0;
    if (held) this.sql.exec("DELETE FROM trip WHERE switch = ?", name);
    return held;
  }

  /** True the first time a key is seen on a UTC day: a warning is sent once a day. */
  alertOnce(key: string, now: number): boolean {
    const day = periodKey("day", now);
    const held = this.sql.exec("SELECT day FROM alert WHERE key = ?", key).toArray()[0];
    if (held?.day === day) return false;
    this.sql.exec("INSERT OR REPLACE INTO alert (key, day) VALUES (?, ?)", key, day);
    return true;
  }

  /** Replaces the cap overrides (`cap.<name>` rows) the guard applies as lower maxima. */
  setOverrides(values: Readonly<Record<string, number>>): void {
    this.sql.exec("DELETE FROM override");
    for (const [name, value] of Object.entries(values))
      if (Number.isFinite(value) && value >= 0)
        this.sql.exec("INSERT INTO override (name, value) VALUES (?, ?)", name, value);
  }

  overrides(): Record<string, number> {
    return Object.fromEntries(
      this.sql
        .exec("SELECT name, value FROM override")
        .toArray()
        .map((r) => [String(r.name), Number(r.value)]),
    );
  }

  /** Consecutive runs with a failed analytics read; 0 after a clean one. */
  analyticsRun(failed: boolean): number {
    const streak = failed
      ? Number(this.sql.exec("SELECT value FROM kv WHERE key = 'analytics_fails'").toArray()[0]?.value ?? 0) + 1
      : 0;
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('analytics_fails', ?)", streak);
    return streak;
  }
}

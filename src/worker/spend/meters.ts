// The SpendGuard's logic over a SqlLike, so unit tests run it on node:sqlite (like demo-slots.ts) and the Durable
// Object only adds the clock. Every method is synchronous: a check and the write it allows run with no await
// between them, which is what makes a cap exact under concurrent callers.
import type { SqlLike } from "../do/demo-slots.ts";
import {
  type Caps,
  isMeter,
  isPool,
  isScoped,
  type Limit,
  METERS,
  type MeterDef,
  type MeterName,
  msToPeriodEnd,
  type Period,
  POOLS,
  type PoolName,
  PRICED_METERS,
  type PricedMeter,
  periodKey,
} from "./caps.ts";
import { migrate, type Transaction } from "./schema.ts";
import { isStricter, type SwitchName } from "./switches.ts";

const DAY_MS = 86_400_000;
const dayStart = (at: number) => at - (at % DAY_MS);

export interface History {
  /** Completed UTC days since the guard first woke: how much of `series` means anything. */
  ageDays: number;
  /** Daily all-scopes totals per priced meter; index 0 is today (in progress), 1 is yesterday. */
  series: Record<PricedMeter, number[]>;
}

/** The all-scopes counter row's scope. A real scope is an id or a hash and never empty. */
const ALL = "";
/** Counter name the breaker reads for leases dropped past their grace. */
const OVERDUE_METER = "lease_overdue";
/** Dropped leases the owner has already reset past, same day: the breaker trips only on a count above it. */
const OVERDUE_SEEN_METER = "lease_overdue_seen";

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
}
export interface TripRow {
  switch: SwitchName;
  value: string;
  trippedAt: number;
  reason: string;
  reading: string;
  alerted: boolean;
  /** The row value before the first trip on this switch; '' when there was none. A reset restores it. */
  prior: string;
}
export interface Snapshot {
  at: number;
  /** The caps in force (var or default, lowered by any override). */
  caps: Caps;
  /** Current-period, all-scopes counts for every meter. */
  counters: Record<MeterName, PeriodCounts>;
  pools: Record<PoolName, PoolGauge>;
  /** Leases dropped past deadline plus grace today: a Converter that did not destroy its container. */
  leasesDroppedToday: number;
  /** Of those, how many an owner reset has already answered. */
  leasesDroppedSeen: number;
  trips: TripRow[];
}

export const positiveInt = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${what} must be a positive integer`);
  return n;
};

/** The argument checks of take and refund, shared with the client so a caller bug throws before any RPC. */
export function checkCounted(meter: MeterName, n: number, scope: string | undefined): void {
  positiveInt(n, "n");
  if (!isMeter(meter)) throw new RangeError(`unknown meter ${meter}`);
  if (isScoped(meter) && !scope) throw new RangeError(`meter ${meter} needs a scope`);
}

/** The argument checks of acquire: a pool with a per-scope cap needs a scope, or that cap would be skipped. */
export function checkAcquire(pool: PoolName, ttlSeconds: number, scope: string | undefined): void {
  if (!isPool(pool)) throw new RangeError(`unknown pool ${pool}`);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new RangeError("ttlSeconds must be positive");
  if ("perScopeCap" in POOLS[pool] && !scope) throw new RangeError(`pool ${pool} needs a scope`);
}
const retrySeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export class Ledger {
  constructor(
    private readonly sql: SqlLike,
    clock: () => number = Date.now,
    transaction: Transaction = (fn) => fn(),
  ) {
    migrate(sql, transaction);
    this.sql.exec("INSERT OR IGNORE INTO kv (key, value) VALUES ('born', ?)", dayStart(clock()));
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

  private rows(meter: MeterName, scope: string | undefined, at: number): [string, string][] {
    const out: [string, string][] = [];
    const own = isScoped(meter) ? scope : undefined;
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
    checkCounted(meter, n, scope);
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

  /**
   * Gives back part of an earlier take; `at` is when it was taken, so a midnight crossing refunds the right day. A
   * refund is for work that never started, so an `at` in the future or older than the longest lease plus its grace
   * is a caller bug and does nothing (false); a counter never goes below zero. A scoped meter needs the scope, and
   * each period gives back at most what that scope's own row holds, from its row and from the all-scopes row alike,
   * so one caller cannot erase another's counts. `id` is the take ticket's: a second refund of it does nothing.
   */
  refund(
    meter: MeterName,
    n: number,
    scope: string | undefined,
    at: number,
    id: string,
    now: number,
    caps: Caps,
  ): boolean {
    checkCounted(meter, n, scope);
    if (!id) throw new RangeError("a refund needs its ticket id");
    const window =
      (Math.max(caps.lease_max_convert_seconds, caps.lease_max_export_seconds) + caps.lease_grace_seconds) * 1000;
    if (!Number.isFinite(at) || at > now || now - at > window) return false;
    if (this.sql.exec("SELECT 1 AS one FROM refunded WHERE id = ?", id).toArray().length > 0) return false;
    this.sql.exec("INSERT INTO refunded (id, day) VALUES (?, ?)", id, periodKey("day", now));
    const own = isScoped(meter) ? scope : undefined;
    for (const p of this.periods(meter)) {
      const key = periodKey(p, at);
      const back = own ? Math.min(n, this.get(meter, own, key)) : n;
      this.add(meter, ALL, key, -back);
      if (own) this.add(meter, own, key, -back);
    }
    return true;
  }

  /** Takes a pool slot for at most `ttlSeconds` (clamped to the pool's maximum). Busy, with nothing held, when full. */
  acquire(pool: PoolName, scope: string | undefined, ttlSeconds: number, caps: Caps, now: number): AcquireResult {
    checkAcquire(pool, ttlSeconds, scope);
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
      const row = this.sql.exec("SELECT count(*) AS live FROM lease WHERE pool = ?", pool).toArray()[0];
      pools[pool] = { live: Number(row?.live ?? 0) };
    }
    return {
      at: now,
      caps,
      counters,
      pools,
      leasesDroppedToday: this.get(OVERDUE_METER, ALL, periodKey("day", now)),
      leasesDroppedSeen: this.get(OVERDUE_SEEN_METER, ALL, periodKey("day", now)),
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
    this.sql.exec("DELETE FROM refunded WHERE day < ?", periodKey("day", now - 2 * 86_400_000));
  }

  // Breaker state: latched until reset, one alert per trip.

  /**
   * Latches a switch value. False (nothing changes) when the switch is already latched at this value or a stricter
   * one. `prior` is the switch's row value before the breaker touched it ('' for no row); a stricter trip on the
   * same switch keeps the first one's, so a reset restores what was there before any trip.
   */
  latchTrip(name: SwitchName, value: string, reason: string, reading: string, now: number, prior = ""): boolean {
    const held = this.sql.exec("SELECT value, prior FROM trip WHERE switch = ?", name).toArray()[0];
    if (held && !isStricter(name, value, String(held.value))) return false;
    this.sql.exec(
      "INSERT OR REPLACE INTO trip (switch, value, tripped_at, reason, reading, alerted, prior) VALUES (?, ?, ?, ?, ?, 0, ?)",
      name,
      value,
      now,
      reason,
      reading,
      held ? String(held.prior) : prior,
    );
    return true;
  }

  trips(): TripRow[] {
    return this.sql
      .exec("SELECT switch, value, tripped_at, reason, reading, alerted, prior FROM trip ORDER BY tripped_at, switch")
      .toArray()
      .map((r) => ({
        switch: String(r.switch) as SwitchName,
        value: String(r.value),
        trippedAt: Number(r.tripped_at),
        reason: String(r.reason),
        reading: String(r.reading),
        alerted: Number(r.alerted) === 1,
        prior: String(r.prior),
      }));
  }

  /** Marks the alert for exactly this latched value sent; a later, stricter trip is a new alert. */
  markAlerted(name: SwitchName, value: string): void {
    this.sql.exec("UPDATE trip SET alerted = 1 WHERE switch = ? AND value = ?", name, value);
  }

  /**
   * Clears a latch. Resetting `convert` also takes the day's dropped-lease count as seen, so only a lease dropped
   * after the reset trips it again.
   */
  resetTrip(name: SwitchName, now: number, caps: Caps): boolean {
    const held = this.sql.exec("SELECT 1 AS one FROM trip WHERE switch = ?", name).toArray().length > 0;
    if (held) this.sql.exec("DELETE FROM trip WHERE switch = ?", name);
    if (name === "convert") {
      this.dropLapsed(now, caps);
      const day = periodKey("day", now);
      const seen = this.get(OVERDUE_SEEN_METER, ALL, day);
      this.add(OVERDUE_SEEN_METER, ALL, day, this.get(OVERDUE_METER, ALL, day) - seen);
    }
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

  /** Daily totals for the learning and the report. Days with no row count as 0: nothing happened. */
  history(now: number, days: number): History {
    const born = Number(this.sql.exec("SELECT value FROM kv WHERE key = 'born'").toArray()[0]?.value ?? dayStart(now));
    const series = {} as Record<PricedMeter, number[]>;
    const oldest = periodKey("day", now - days * DAY_MS);
    for (const meter of PRICED_METERS) {
      const byDay = new Map(
        this.sql
          .exec(
            "SELECT period, n FROM counter WHERE meter = ? AND scope = ? AND period >= ? AND period < 'e'",
            meter,
            ALL,
            oldest,
          )
          .toArray()
          .map((r) => [String(r.period), Number(r.n)]),
      );
      series[meter] = Array.from({ length: days + 1 }, (_, i) => byDay.get(periodKey("day", now - i * DAY_MS)) ?? 0);
    }
    return { ageDays: Math.max(0, Math.floor((dayStart(now) - born) / DAY_MS)), series };
  }

  /** Forgets a key's once-a-day claim, so a send that failed is tried again on the next run. */
  unalert(key: string): void {
    this.sql.exec("DELETE FROM alert WHERE key = ?", key);
  }

  setBlob(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO blob (key, value) VALUES (?, ?)", key, value);
  }

  blob(key: string): string | undefined {
    const row = this.sql.exec("SELECT value FROM blob WHERE key = ?", key).toArray()[0];
    return row === undefined ? undefined : String(row.value);
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

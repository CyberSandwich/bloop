// What callers hold: the SpendGuard's RPC surface behind a wrapper with a fail mode per meter. A guard that cannot be
// reached refuses costly work (containers, part mints, uploads, exports, R2 charges) and says so; the two public
// paths that must not depend on one object (the demo and email, including sign-in codes) fail open, bounded by a
// per-isolate count. Presenting an already-converted file never calls the guard.
// No import of guard.ts here: the Durable Object module needs Workers types, and this one runs under Node in tests.
import { type CapName, type Caps, type MeterName, msToPeriodEnd, type PoolName } from "./caps.ts";
import type { AcquireResult, History, Snapshot, TakeResult } from "./meters.ts";
import type { SwitchName } from "./switches.ts";

/** The Durable Object's methods, all synchronous inside it: a check and its write never straddle an await. */
export interface SpendOps {
  take(meter: MeterName, n: number, scope?: string): TakeResult;
  record(meter: MeterName, n: number, scope?: string): void;
  refund(meter: MeterName, n: number, scope: string | undefined, at: number): void;
  acquire(pool: PoolName, ttlSeconds: number, scope?: string): AcquireResult;
  release(leaseId: string): boolean;
  snapshot(): Snapshot;
  prune(): void;
  /** `prior`: the switch's row value before this trip ('' for none), restored on reset. */
  latchTrip(name: SwitchName, value: string, reason: string, reading: string, prior?: string): boolean;
  markAlerted(name: SwitchName, value: string): void;
  resetTrip(name: SwitchName): boolean;
  alertOnce(key: string): boolean;
  unalert(key: string): void;
  history(days: number): History;
  /** The breaker stores its latest report (JSON) here; the admin panel and route read it back. */
  setReport(json: string): void;
  report(): string | undefined;
  /** The merged analytics series and gauges of the latest runs (JSON), so a failed dataset keeps its last good one. */
  setLastAnalytics(json: string): void;
  lastAnalytics(): string | undefined;
  setOverrides(values: Record<string, number>): void;
  analyticsRun(failed: boolean): number;
}

/** The same methods as a caller sees them through a stub. */
export type SpendRpc = {
  [K in keyof SpendOps]: (...args: Parameters<SpendOps[K]>) => Promise<ReturnType<SpendOps[K]>>;
};

export type Unavailable = { ok: false; reason: "unavailable"; retryAfterSeconds: number };
const UNAVAILABLE_RETRY_SECONDS = 30;
const unavailable: Unavailable = { ok: false, reason: "unavailable", retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };

export interface Refusal {
  status: 429 | 503;
  code: "rate_limited" | "service_busy";
  retryAfterSeconds: number;
}

/** The response every caller sends when a take or acquire is refused: 429 for a cap, 503 for busy or unreachable. */
export function refusal(result: TakeResult | AcquireResult | Unavailable): Refusal {
  if (result.ok) throw new TypeError("not a refusal");
  return result.reason === "cap_hit"
    ? { status: 429, code: "rate_limited", retryAfterSeconds: result.retryAfterSeconds }
    : { status: 503, code: "service_busy", retryAfterSeconds: result.retryAfterSeconds };
}

/**
 * Meters a caller counts with `take` or `record`. R2 operations go through `charge` (one call per request) and D1
 * rows are read from analytics, so neither is a caller's meter.
 */
export type CallerMeter = Exclude<MeterName, "r2_class_a" | "r2_class_b" | "d1_writes">;

/**
 * What routes and Durable Objects receive in their deps instead of a global: unit tests of U, V2 and A pass a fake
 * and never start the guard. `spendFor(env)` builds the real one at the composition root only.
 */
export interface Spend {
  /** Adds to a capped meter, or refuses. */
  take(meter: CallerMeter, n: number, scope?: string): Promise<TakeResult | Unavailable>;
  /** Charges `n` R2 operations of a class against the exact monthly cap, once per request. */
  charge(cls: "A" | "B", n: number): Promise<TakeResult | Unavailable>;
  /** Takes a pool slot, or says busy. */
  acquire(pool: PoolName, ttlSeconds: number, scope?: string): Promise<AcquireResult | Unavailable>;
  release(leaseId: string): Promise<void>;
  record(meter: CallerMeter, n: number, scope?: string): Promise<void>;
  refund(meter: CallerMeter, n: number, scope: string | undefined, takenAt: number): Promise<void>;
  /** For /admin; null when the guard cannot be reached. */
  snapshot(): Promise<Snapshot | null>;
}

/** Meters that fail open when the guard is unreachable, with the cap that bounds each isolate meanwhile. */
const OPEN_ON_OUTAGE: Partial<Record<CallerMeter, CapName>> = {
  email: "isolate_open_email_day",
  email_code: "isolate_open_email_code_ip_day",
  demo_session: "isolate_open_demo_session_day",
};

/** Counts per UTC day inside one Worker isolate: what a fail-open meter allows while the guard is down. */
export class IsolateCounts {
  private day = "";
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True and counted while the key is under `cap` today. */
  admit(key: string, cap: number): boolean {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.seen.clear();
    }
    const used = this.seen.get(key) ?? 0;
    if (used + 1 > cap) return false;
    this.seen.set(key, used + 1);
    return true;
  }
}

/** One per isolate, so every route's client in the isolate shares the count. */
const isolateCounts = new IsolateCounts();

export class SpendClient implements Spend {
  /** `stub` is called per use: a Durable Object stub is not reusable across requests. */
  constructor(
    private readonly stub: () => SpendRpc,
    private readonly caps: Caps,
    private readonly log: (line: string) => void = console.error,
    private readonly isolate: IsolateCounts = isolateCounts,
    private readonly now: () => number = Date.now,
  ) {}

  private fail(op: string, e: unknown): void {
    this.log(JSON.stringify({ evt: "spend_guard_error", op, error: e instanceof Error ? e.message : "unknown" }));
  }

  /** The guard is down: fail open for the public paths, within this isolate's cap, and closed for the rest. */
  private outage(meter: CallerMeter, n: number, scope: string | undefined): TakeResult | Unavailable {
    const capName = OPEN_ON_OUTAGE[meter];
    if (!capName) return unavailable;
    const cap = this.caps[capName];
    const admitted = n === 1 && this.isolate.admit(`${meter}|${scope ?? ""}`, cap);
    this.log(JSON.stringify({ evt: "spend_guard_open", meter, admitted }));
    if (admitted) return { ok: true };
    return {
      ok: false,
      reason: "cap_hit",
      meter,
      period: "day",
      scope: scope ? "own" : "all",
      retryAfterSeconds: Math.max(1, Math.ceil(msToPeriodEnd("day", this.now()) / 1000)),
    };
  }

  async take(meter: CallerMeter, n: number, scope?: string): Promise<TakeResult | Unavailable> {
    try {
      return await this.stub().take(meter, n, scope);
    } catch (e) {
      this.fail("take", e);
      return this.outage(meter, n, scope);
    }
  }

  async charge(cls: "A" | "B", n: number): Promise<TakeResult | Unavailable> {
    try {
      return await this.stub().take(cls === "A" ? "r2_class_a" : "r2_class_b", n);
    } catch (e) {
      this.fail("charge", e);
      return unavailable;
    }
  }

  /** Unreachable counts as busy. */
  async acquire(pool: PoolName, ttlSeconds: number, scope?: string): Promise<AcquireResult | Unavailable> {
    try {
      return await this.stub().acquire(pool, ttlSeconds, scope);
    } catch (e) {
      this.fail("acquire", e);
      return unavailable;
    }
  }

  /** The three below never refuse work: they report what already happened, so a lost call is logged, not thrown. */
  async release(leaseId: string): Promise<void> {
    try {
      await this.stub().release(leaseId);
    } catch (e) {
      this.fail("release", e);
    }
  }

  async record(meter: CallerMeter, n: number, scope?: string): Promise<void> {
    try {
      await this.stub().record(meter, n, scope);
    } catch (e) {
      this.fail("record", e);
    }
  }

  async refund(meter: CallerMeter, n: number, scope: string | undefined, takenAt: number): Promise<void> {
    try {
      await this.stub().refund(meter, n, scope, takenAt);
    } catch (e) {
      this.fail("refund", e);
    }
  }

  async snapshot(): Promise<Snapshot | null> {
    try {
      return await this.stub().snapshot();
    } catch (e) {
      this.fail("snapshot", e);
      return null;
    }
  }
}

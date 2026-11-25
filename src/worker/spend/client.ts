// What callers hold: the SpendGuard's RPC surface behind a wrapper with a fail mode per meter. A guard that cannot be
// reached refuses costly work (containers, part mints, uploads, exports, R2 charges) and says so; the three public
// meters (the demo, email, sign-in codes) live on a second guard instance and fail open, bounded by a per-isolate
// count, so neither a flood of public calls nor an outage of one instance takes the other down. Presenting an
// already-converted file never calls the guard.
// A caller bug (a bad `n`, a missing scope) throws before any RPC: only a transport error counts as an outage.
// No import of guard.ts here: the Durable Object module needs Workers types, and this one runs under Node in tests.
import { type CapName, type Caps, type MeterName, msToPeriodEnd, type PoolName, periodKey } from "./caps.ts";
import {
  type AcquireResult,
  checkAcquire,
  checkCounted,
  type History,
  positiveInt,
  type Snapshot,
  type TakeRefusal,
  type TakeResult,
} from "./meters.ts";
import type { SwitchName } from "./switches.ts";

/** The Durable Object's methods, all synchronous inside it: a check and its write never straddle an await. */
export interface SpendOps {
  take(meter: MeterName, n: number, scope?: string): TakeResult;
  record(meter: MeterName, n: number, scope?: string): void;
  /** `id`: the take ticket's; the guard honors each id once. */
  refund(meter: MeterName, n: number, scope: string | undefined, at: number, id: string): void;
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
 * What a take hands back, and the only thing `refund` accepts: it carries the scope the take was made under, so a
 * refund can neither name another caller's scope nor exceed what was taken. `takenAt` 0 marks a take the guard never
 * counted (admitted while it was down); the guard ignores a refund that old.
 */
export interface TakeTicket {
  /** Random, 96 bits: the guard refunds a ticket once, so a second refund of it does nothing. */
  id: string;
  meter: CallerMeter;
  n: number;
  scope?: string;
  takenAt: number;
}
export type Taken = { ok: true; ticket: TakeTicket };

/** 12 random bytes as base64url (no padding at this length). */
const ticketId = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))))
    .replaceAll("+", "-")
    .replaceAll("/", "_");

/**
 * What routes and Durable Objects receive in their deps instead of a global: unit tests of U, V2 and A pass a fake
 * and never start the guard. `spendFor(env)` builds the real one at the composition root only.
 */
export interface Spend {
  /** Adds to a capped meter, or refuses. A scoped meter needs a scope; `n` is a positive integer. */
  take(meter: CallerMeter, n: number, scope?: string): Promise<Taken | TakeRefusal | Unavailable>;
  /** Charges `n` R2 operations of a class against the exact monthly cap, once per request. */
  charge(cls: "A" | "B", n: number): Promise<TakeResult | Unavailable>;
  /** Takes a pool slot, or says busy. A pool with a per-scope cap needs a scope. */
  acquire(pool: PoolName, ttlSeconds: number, scope?: string): Promise<AcquireResult | Unavailable>;
  /** Idempotent, so a lost response is retried once. */
  release(leaseId: string): Promise<void>;
  record(meter: CallerMeter, n: number, scope?: string): Promise<void>;
  /** Gives back up to `n` (default all) of an earlier take, for work that never started. */
  refund(ticket: TakeTicket, n?: number): Promise<void>;
}

/** Meters on the public instance: they fail open when it is unreachable, with the cap that bounds each isolate. */
const OPEN_ON_OUTAGE: Partial<Record<CallerMeter, CapName>> = {
  email: "isolate_open_email_day",
  email_code: "isolate_open_email_code_ip_day",
  demo_session: "isolate_open_demo_session_day",
};

export const PUBLIC_METERS = Object.keys(OPEN_ON_OUTAGE) as CallerMeter[];

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

/** R2 operations an isolate has reserved from the guard and not yet spent, per class. Never returned, dropped at the month's end. */
export class Reserves {
  private month = "";
  private readonly held = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private roll(): void {
    const month = periodKey("month", this.now());
    if (month === this.month) return;
    this.month = month;
    this.held.clear();
  }

  left(cls: string): number {
    this.roll();
    return this.held.get(cls) ?? 0;
  }

  /** Spends up to `n` from the reserve. */
  drain(cls: string, n: number): void {
    const have = this.left(cls);
    this.held.set(cls, have - Math.min(have, n));
  }

  add(cls: string, n: number): void {
    this.held.set(cls, this.left(cls) + n);
  }
}

/** One per isolate, so every route's client in the isolate shares the count. */
const isolateCounts = new IsolateCounts();
const isolateReserves = new Reserves();

export interface SpendStubs {
  /** Every costly meter, the pools, the breaker's state. */
  global: () => SpendRpc;
  /** The `OPEN_ON_OUTAGE` meters only. */
  public: () => SpendRpc;
}

export class SpendClient implements Spend {
  /** The stubs are called per use (a Durable Object stub is not reusable across requests), and so are the caps. */
  constructor(
    private readonly stubs: SpendStubs,
    private readonly caps: () => Caps,
    private readonly log: (line: string) => void = console.error,
    private readonly isolate: IsolateCounts = isolateCounts,
    private readonly now: () => number = Date.now,
    private readonly reserves: Reserves = isolateReserves,
  ) {}

  private fail(op: string, e: unknown): void {
    this.log(JSON.stringify({ evt: "spend_guard_error", op, error: e instanceof Error ? e.message : "unknown" }));
  }

  private rpc(meter: CallerMeter): SpendRpc {
    return Object.hasOwn(OPEN_ON_OUTAGE, meter) ? this.stubs.public() : this.stubs.global();
  }

  private ticket(meter: CallerMeter, n: number, scope: string | undefined, takenAt: number): Taken {
    return { ok: true, ticket: { id: ticketId(), meter, n, ...(scope ? { scope } : {}), takenAt } };
  }

  /** The guard is down: fail open for the public meters, within this isolate's cap, and closed for the rest. */
  private outage(meter: CallerMeter, n: number, scope: string | undefined): Taken | TakeRefusal | Unavailable {
    const capName = OPEN_ON_OUTAGE[meter];
    if (!capName) return unavailable;
    const admitted = n === 1 && this.isolate.admit(`${meter}|${scope ?? ""}`, this.caps()[capName]);
    this.log(JSON.stringify({ evt: "spend_guard_open", meter, admitted }));
    if (admitted) return this.ticket(meter, n, scope, 0);
    return {
      ok: false,
      reason: "cap_hit",
      meter,
      period: "day",
      scope: scope ? "own" : "all",
      retryAfterSeconds: Math.max(1, Math.ceil(msToPeriodEnd("day", this.now()) / 1000)),
    };
  }

  async take(meter: CallerMeter, n: number, scope?: string): Promise<Taken | TakeRefusal | Unavailable> {
    checkCounted(meter, n, scope);
    try {
      const result = await this.rpc(meter).take(meter, n, scope);
      return result.ok ? this.ticket(meter, n, scope, this.now()) : result;
    } catch (e) {
      this.fail("take", e);
      return this.outage(meter, n, scope);
    }
  }

  /**
   * Spends from this isolate's reserve; when it runs short, reserves whole blocks from the guard (`r2_block_ops`)
   * and keeps the leftover, never returning it, so the guard's count only errs high. Near the cap, where a whole
   * block no longer fits, it takes exactly what is short, so the cap still refuses at the exact operation. The
   * reserve is touched only once the guard has answered: a refused or lost charge leaves it for the next one.
   */
  async charge(cls: "A" | "B", n: number): Promise<TakeResult | Unavailable> {
    positiveInt(n, "n");
    const have = this.reserves.left(cls);
    if (have >= n) {
      this.reserves.drain(cls, n);
      return { ok: true };
    }
    const short = n - have;
    const meter = cls === "A" ? "r2_class_a" : "r2_class_b";
    const block = Math.max(1, Math.floor(this.caps().r2_block_ops));
    const whole = Math.ceil(short / block) * block;
    try {
      const guard = this.stubs.global();
      let result = await guard.take(meter, whole);
      let got = whole;
      if (!result.ok && result.reason === "cap_hit" && whole > short) {
        result = await guard.take(meter, short);
        got = short;
      }
      if (result.ok) {
        this.reserves.drain(cls, have);
        this.reserves.add(cls, got - short);
      }
      return result;
    } catch (e) {
      this.fail("charge", e);
      return unavailable;
    }
  }

  /** Unreachable counts as busy. */
  async acquire(pool: PoolName, ttlSeconds: number, scope?: string): Promise<AcquireResult | Unavailable> {
    checkAcquire(pool, ttlSeconds, scope);
    try {
      return await this.stubs.global().acquire(pool, ttlSeconds, scope);
    } catch (e) {
      this.fail("acquire", e);
      return unavailable;
    }
  }

  /** The three below never refuse work: they report what already happened, so a lost call is logged, not thrown. */
  async release(leaseId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.stubs.global().release(leaseId);
        return;
      } catch (e) {
        this.fail("release", e);
      }
    }
  }

  async record(meter: CallerMeter, n: number, scope?: string): Promise<void> {
    positiveInt(n, "n");
    try {
      await this.rpc(meter).record(meter, n, scope);
    } catch (e) {
      this.fail("record", e);
    }
  }

  async refund(ticket: TakeTicket, n: number = ticket.n): Promise<void> {
    positiveInt(n, "n");
    if (n > ticket.n) throw new RangeError("a refund cannot exceed the take");
    try {
      await this.rpc(ticket.meter).refund(ticket.meter, n, ticket.scope, ticket.takenAt, ticket.id);
    } catch (e) {
      this.fail("refund", e);
    }
  }
}

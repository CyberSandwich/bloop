// What callers hold: the SpendGuard's RPC surface behind a wrapper that fails closed. A guard that cannot be reached
// refuses costly work (never lets it through) and says so; presenting an already-converted file never calls it.
// No import of guard.ts here: the Durable Object module needs Workers types, and this one runs under Node in tests.
import type { MeterName, PoolName } from "./caps.ts";
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
  latchTrip(name: SwitchName, value: string, reason: string, reading: string): boolean;
  markAlerted(name: SwitchName, value: string): void;
  resetTrip(name: SwitchName): boolean;
  alertOnce(key: string): boolean;
  unalert(key: string): void;
  history(days: number): History;
  /** The breaker stores its latest report (JSON) here; the admin panel and route read it back. */
  setReport(json: string): void;
  report(): string | undefined;
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

export class SpendClient {
  /** `stub` is called per use: a Durable Object stub is not reusable across requests. */
  constructor(
    private readonly stub: () => SpendRpc,
    private readonly log: (line: string) => void = console.error,
  ) {}

  private fail(op: string, e: unknown): void {
    this.log(JSON.stringify({ evt: "spend_guard_error", op, error: e instanceof Error ? e.message : "unknown" }));
  }

  /** Adds to a capped meter, or refuses. Unreachable counts as refused. */
  async take(meter: MeterName, n: number, scope?: string): Promise<TakeResult | Unavailable> {
    try {
      return await this.stub().take(meter, n, scope);
    } catch (e) {
      this.fail("take", e);
      return unavailable;
    }
  }

  /** Takes a pool slot, or says busy. Unreachable counts as busy. */
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

  async record(meter: MeterName, n: number, scope?: string): Promise<void> {
    try {
      await this.stub().record(meter, n, scope);
    } catch (e) {
      this.fail("record", e);
    }
  }

  async refund(meter: MeterName, n: number, scope: string | undefined, takenAt: number): Promise<void> {
    try {
      await this.stub().refund(meter, n, scope, takenAt);
    } catch (e) {
      this.fail("refund", e);
    }
  }

  /** For /admin; null when the guard cannot be reached. */
  async snapshot(): Promise<Snapshot | null> {
    try {
      return await this.stub().snapshot();
    } catch (e) {
      this.fail("snapshot", e);
      return null;
    }
  }
}

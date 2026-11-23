// Metrics seam (docs/interfaces.md section 7). The Screen object calls `record` at the transitions
// that carry a measurement.
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

export interface Metrics {
  record(e: MetricEvent): Promise<void>;
  /** Week-3 return: one row per pseudonymous user per ISO week. */
  activeWeek(userId: string, now: number): Promise<void>;
  rollup(day: string): Promise<void>; // metric_event to metric_daily
  purge(now: number, days: number): Promise<number>;
}

/** Stub: keeps nothing. The D1 implementation replaces it in stores.ts. */
export const noopMetrics: Metrics = {
  async record() {},
  async activeWeek() {},
  async rollup() {},
  async purge() {
    return 0;
  },
};

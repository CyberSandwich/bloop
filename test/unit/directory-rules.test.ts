import { describe, expect, it } from "vitest";
import {
  GLOBAL_ALARM_MISSES,
  isBlocked,
  MISS_LIMIT,
  MISS_WINDOW_MS,
  type MissRow,
  recordGlobalMiss,
  recordMiss,
} from "../../src/worker/do/directory-rules.ts";

const T = 5_000_000;

function misses(n: number, start = T): MissRow | null {
  let row: MissRow | null = null;
  for (let i = 0; i < n; i++) row = recordMiss(row, start + i);
  return row;
}

describe("PAIR-07 limits: the global miss alarm", () => {
  /** Feeds `n` misses one by one and returns which of them raised the alarm (1-based). */
  function alarms(n: number, start = T): number[] {
    let row: MissRow | null = null;
    const fired: number[] = [];
    for (let i = 1; i <= n; i++) {
      const step = recordGlobalMiss(row, start + i);
      row = step.row;
      if (step.alarm) fired.push(i);
    }
    return fired;
  }

  it("fires once, on the 1,000th miss in a window, and not before or after", () => {
    expect(alarms(GLOBAL_ALARM_MISSES - 1)).toEqual([]);
    expect(alarms(GLOBAL_ALARM_MISSES + 500)).toEqual([GLOBAL_ALARM_MISSES]);
  });

  it("starts over when the window ends", () => {
    const full = { count: GLOBAL_ALARM_MISSES + 5, windowStart: T };
    const next = recordGlobalMiss(full, T + MISS_WINDOW_MS);
    expect(next).toEqual({ row: { count: 1, windowStart: T + MISS_WINDOW_MS }, alarm: false });
  });
});

describe("PAIR-07 limits: exact miss counting per IP hash", () => {
  it("lets the first ten misses through and blocks from the eleventh lookup", () => {
    expect(isBlocked(null, T)).toBe(false);
    expect(isBlocked(misses(MISS_LIMIT - 1), T + 100)).toBe(false);
    expect(isBlocked(misses(MISS_LIMIT), T + 100)).toBe(true);
  });

  it("starts a count at one and counts within the window", () => {
    expect(recordMiss(null, T)).toEqual({ count: 1, windowStart: T });
    expect(recordMiss({ count: 4, windowStart: T }, T + 1000)).toEqual({ count: 5, windowStart: T });
  });

  it("stays blocked until the window ends, then resets", () => {
    const row = misses(MISS_LIMIT);
    expect(isBlocked(row, T + MISS_WINDOW_MS - 1)).toBe(true);
    expect(isBlocked(row, T + MISS_WINDOW_MS)).toBe(false);
    expect(recordMiss(row, T + MISS_WINDOW_MS)).toEqual({ count: 1, windowStart: T + MISS_WINDOW_MS });
  });

  it("does not extend the window with later misses", () => {
    const row = recordMiss({ count: 3, windowStart: T }, T + MISS_WINDOW_MS - 1);
    expect(row.windowStart).toBe(T);
  });
});

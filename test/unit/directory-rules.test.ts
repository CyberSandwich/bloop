import { describe, expect, it } from "vitest";
import {
  isBlocked,
  MISS_LIMIT,
  MISS_WINDOW_MS,
  type MissRow,
  recordMiss,
} from "../../src/worker/do/directory-rules.ts";

const T = 5_000_000;

function misses(n: number, start = T): MissRow | null {
  let row: MissRow | null = null;
  for (let i = 0; i < n; i++) row = recordMiss(row, start + i);
  return row;
}

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

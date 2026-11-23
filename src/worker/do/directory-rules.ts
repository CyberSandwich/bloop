// Exact guess limits for typed codes (threat model PAIR-07). Pure, so the window logic is unit-tested.

export const MISS_LIMIT = 10;
export const MISS_WINDOW_MS = 10 * 60 * 1000;

export interface MissRow {
  count: number;
  windowStart: number;
}

const live = (row: MissRow | null, now: number): MissRow | null =>
  row && now - row.windowStart < MISS_WINDOW_MS ? row : null;

/** After MISS_LIMIT misses in a window every lookup from that IP hash is refused until the window ends. */
export function isBlocked(row: MissRow | null, now: number): boolean {
  return (live(row, now)?.count ?? 0) >= MISS_LIMIT;
}

/** The row after one more miss; a lapsed window starts over. */
export function recordMiss(row: MissRow | null, now: number): MissRow {
  const current = live(row, now);
  return current ? { count: current.count + 1, windowStart: current.windowStart } : { count: 1, windowStart: now };
}

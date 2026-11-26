// Exact guess limits for typed codes (threat model PAIR-07). Pure, so the window logic is unit-tested.
import type { ClaimWho, Lookup } from "../seams/pairing.ts";

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

/** Misses across all IP hashes in one window that raise the alarm (a botnet, not a person). It never blocks anyone. */
export const GLOBAL_ALARM_MISSES = 1000;

/** The global row after one more miss, and whether this miss is the one that crosses the alarm level. */
export function recordGlobalMiss(row: MissRow | null, now: number): { row: MissRow; alarm: boolean } {
  const next = recordMiss(row, now);
  return { row: next, alarm: next.count === GLOBAL_ALARM_MISSES };
}

/**
 * What a lookup does with a code (PAIR-15): `route` it to its screen, or refuse it, counting a miss or not. A demo code
 * routes anyone. A live one routes a signed-in owner and a guest the drop admits; a signed-out owner is refused
 * unspent and uncounted, since the code is right and the phone signs in to claim it; a guest the drop refuses counts
 * as a miss, like a wrong code, so a stranger cannot probe codes as a guest for free.
 */
export function lookupVerdict(
  hit: { screenRef: string; demo: boolean } | null,
  who: ClaimWho,
): Extract<Lookup, { ok: true }> | { ok: false; miss: boolean; error: Exclude<Lookup, { ok: true }>["error"] } {
  if (!hit) return { ok: false, miss: true, error: "code_unknown" };
  const route = { ok: true, screenRef: hit.screenRef, demo: hit.demo } as const;
  if (hit.demo) return route;
  if (who.kind === "owner") return who.signedIn ? route : { ok: false, miss: false, error: "auth_required" };
  return who.guestRefusal === null ? route : { ok: false, miss: true, error: who.guestRefusal };
}

/** The row after one more miss; a lapsed window starts over. */
export function recordMiss(row: MissRow | null, now: number): MissRow {
  const current = live(row, now);
  return current ? { count: current.count + 1, windowStart: current.windowStart } : { count: 1, windowStart: now };
}

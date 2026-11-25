import { SILENCE_MS } from "../../../public/js/core/timing.js";

/** Sockets waiting for their `hello`, per role: a full role evicts its oldest waiting socket for the next upgrade. */
export const MAX_PENDING_SOCKETS = 4;
/** Of those, one network may hold this many per role, so one client cannot fill the role by itself. */
export const MAX_PENDING_PER_NET = 2;

interface Held {
  authed: boolean;
  role: string;
  net: string;
  helloBy: number;
}
interface Entry {
  att: Held | null;
}

/** Only a socket that sent a verified `hello` counts toward keeping a screen open: a bare upgrade proves nothing. */
export const countAuthed = (attachments: readonly ({ authed: boolean } | null)[]): number =>
  attachments.filter((a) => a?.authed).length;

/**
 * Whether one more socket of `role` from `net` may wait for its `hello`, and the waiting socket to close for it.
 * A socket past its `helloBy` is already dying and counts for nothing.
 */
export function admit<T extends Entry>(
  entries: readonly T[],
  role: string,
  net: string,
  now: number,
): { ok: false } | { ok: true; evict: T | null } {
  const waiting = entries.filter((e) => e.att && !e.att.authed && e.att.role === role && e.att.helloBy > now);
  if (waiting.filter((e) => e.att?.net === net).length >= MAX_PENDING_PER_NET) return { ok: false };
  if (waiting.length < MAX_PENDING_SOCKETS) return { ok: true, evict: null };
  const oldest = waiting.reduce((a, b) => ((a.att?.helloBy ?? 0) <= (b.att?.helloBy ?? 0) ? a : b));
  return { ok: true, evict: oldest };
}

/** A socket is live while it said something (its `hello`, or a ping the runtime answered) within `SILENCE_MS`. */
export const isLive = (heardAt: number, now: number): boolean => now - heardAt < SILENCE_MS;

import { SILENCE_MS } from "../../../public/js/core/timing.js";

/** Sockets waiting for their `hello`, per role: a full role evicts its oldest waiting socket for the next upgrade. */
export const MAX_PENDING_SOCKETS = 4;
/** Of those, one network may hold this many per role; past it the network's own oldest goes, never another's. */
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

const oldest = <T extends Entry>(list: readonly T[]): T =>
  list.reduce((a, b) => ((a.att?.helloBy ?? 0) <= (b.att?.helloBy ?? 0) ? a : b));

/**
 * The waiting socket to close so one more socket of `role` from `net` may wait for its `hello`, or null. Every upgrade
 * is admitted: a network at its cap gives up its own oldest, so sockets held open behind a shared address (a venue
 * NAT) cannot keep a real screen out, and a full role gives up its oldest overall. A socket past its `helloBy` is
 * already dying and counts for nothing.
 */
export function admit<T extends Entry>(entries: readonly T[], role: string, net: string, now: number): T | null {
  const waiting = entries.filter((e) => e.att && !e.att.authed && e.att.role === role && e.att.helloBy > now);
  const mine = waiting.filter((e) => e.att?.net === net);
  if (mine.length >= MAX_PENDING_PER_NET) return oldest(mine);
  return waiting.length >= MAX_PENDING_SOCKETS ? oldest(waiting) : null;
}

/** A socket is live while it said something (its `hello`, or a ping the runtime answered) within `SILENCE_MS`. */
export const isLive = (heardAt: number, now: number): boolean => now - heardAt < SILENCE_MS;

interface Screen {
  /** The upgrade's address hash. */
  ip: string;
  /** When its `hello` verified. */
  helloAt: number;
  /** When it was last heard: its `hello` or the last ping the runtime answered. */
  heardAt: number;
}

/**
 * The address a link must come from (OPEN-02), read when the link is checked, so it never goes stale: the live
 * authed screen socket that verified first holds it (a leaked sid's later socket cannot take it from a screen that
 * is still talking), and once that one goes quiet the next live one does. With none live, `stored`: the last
 * verified proof, by `hello` or by poll.
 */
export function bindingIp(screens: readonly Screen[], now: number, stored: string | undefined): string | undefined {
  const live = screens.filter((s) => isLive(s.heardAt, now));
  if (live.length === 0) return stored;
  return live.reduce((a, b) => (a.helloAt <= b.helloAt ? a : b)).ip;
}

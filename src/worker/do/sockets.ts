import { SILENCE_MS } from "../../../public/js/core/timing.js";

/**
 * MISSED_PINGS of the client's PING_MS (public/js/core/health.js, a browser module the Worker build cannot import; a
 * unit test pins the product).
 */
export const TAKEOVER_MS = 50_000;

/** Sockets waiting for their `hello`, per role: a full role evicts one for the next upgrade (admit). */
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
 * NAT) cannot keep a real screen out. A full role gives up the oldest socket of the network holding the most (the
 * oldest overall among networks tied for it), so two or more networks flooding the role pay for it before a lone
 * real screen does. A socket past its `helloBy` is already dying and counts for nothing.
 */
export function admit<T extends Entry>(entries: readonly T[], role: string, net: string, now: number): T | null {
  const waiting = entries.filter((e) => e.att && !e.att.authed && e.att.role === role && e.att.helloBy > now);
  const mine = waiting.filter((e) => e.att?.net === net);
  if (mine.length >= MAX_PENDING_PER_NET) return oldest(mine);
  if (waiting.length < MAX_PENDING_SOCKETS) return null;
  const held = new Map<string | undefined, number>();
  for (const e of waiting) held.set(e.att?.net, (held.get(e.att?.net) ?? 0) + 1);
  const most = Math.max(...held.values());
  return oldest(waiting.filter((e) => held.get(e.att?.net) === most));
}

/** A socket is live while it said something (its `hello`, or a ping the runtime answered) within `silenceMs`. */
export const isLive = (heardAt: number, now: number, silenceMs = SILENCE_MS): boolean => now - heardAt < silenceMs;

interface Screen {
  /** The upgrade's address hash. */
  ip: string;
  /** When its `hello` verified. */
  helloAt: number;
  /** When it was last heard: its `hello` or the last ping the runtime answered. */
  heardAt: number;
}

interface Authed {
  authed: boolean;
  role: string;
  ip?: unknown;
  helloAt?: number;
}

/**
 * The verified screen sockets as bindingIp reads them, each heard at its hello or its last answered ping (`pong`). One
 * with no address (a socket hibernated from before addresses were kept) is left out, so the stored binding holds and
 * the link check fails closed under enforce; that screen re-hellos. No `helloAt` (the same age) counts from now.
 */
export function screensOf(entries: readonly { att: Authed | null; pong: number }[], now: number): Screen[] {
  return entries.flatMap(({ att, pong }) => {
    if (!att?.authed || att.role !== "screen" || typeof att.ip !== "string") return [];
    const helloAt = att.helloAt ?? now;
    return [{ ip: att.ip, helloAt, heardAt: Math.max(helloAt, pong) }];
  });
}

/**
 * The address a link must come from (OPEN-02), read when the link is checked, so it never goes stale: the live
 * authed screen socket that verified first holds it (a leaked sid's later socket cannot take it from a screen that
 * is still talking), and once that one goes quiet the next live one does. With none live, `stored`: the last
 * verified proof, by `hello` or by poll.
 */
export function bindingIp(
  screens: readonly Screen[],
  now: number,
  stored: string | undefined,
  silenceMs = SILENCE_MS,
): string | undefined {
  const live = screens.filter((s) => holds(s, now, silenceMs));
  if (live.length === 0) return stored;
  return live.reduce((a, b) => (a.helloAt <= b.helloAt ? a : b)).ip;
}

/**
 * bindingIp, written through to the store whenever a live holder differs from it, so a holder that took over and
 * then closes stays the fallback instead of the address it replaced.
 */
export function holdBinding(
  screens: readonly Screen[],
  now: number,
  store: { get(): string | undefined; set(ip: string): void },
  silenceMs = SILENCE_MS,
): string | undefined {
  const stored = store.get();
  const ip = bindingIp(screens, now, stored, silenceMs);
  if (ip !== undefined && ip !== stored) store.set(ip);
  return ip;
}

/**
 * The address a verified `hello` binds links to (OPEN-02), or null to leave the binding alone: no string address (a
 * socket hibernated from before addresses were kept), or another screen socket that still holds it.
 */
export function helloBinding(
  ip: unknown,
  others: readonly Screen[],
  now: number,
  silenceMs = SILENCE_MS,
): string | null {
  if (typeof ip !== "string") return null;
  return others.some((s) => holds(s, now, silenceMs)) ? null : ip;
}

/**
 * A screen socket holds the binding while it misses fewer than MISSED_PINGS pings in a row, so a lectern that roamed
 * to a new address takes it over in about 50 s rather than waiting out the silence window it still counts as open in.
 */
const holds = (s: Screen, now: number, silenceMs: number): boolean =>
  isLive(s.heardAt, now, Math.min(TAKEOVER_MS, silenceMs));

/** WebSocket readyState OPEN. */
export const OPEN = 1;

interface Closable {
  readyState: number;
  send(text: string): void;
  close(code: number, reason: string): void;
}

/**
 * Closes each OPEN socket whose `hello` window ran out, telling it why. Never throws: the alarm runs the machine's
 * timer after this, and a socket that closed under us must not skip it.
 */
export function closeLateHellos(
  entries: readonly { ws: Closable; att: { authed: boolean; helloBy: number } | null }[],
  now: number,
): void {
  const frame = JSON.stringify({ v: 1, t: "error", code: "unauthorized", now });
  for (const { ws, att } of entries) {
    if (ws.readyState !== OPEN || !att || att.authed || att.helloBy > now) continue;
    try {
      ws.send(frame);
      ws.close(1008, "hello timeout");
    } catch {
      // closed under us: its close handler updates the count
    }
  }
}

/** Sends to a socket that may have closed under us; its close handler updates the count. */
export function safeSend(ws: { send(text: string): void }, text: string): void {
  try {
    ws.send(text);
  } catch {
    // closed under us
  }
}

/** State frames to one socket closer together than this coalesce, the latest winning (O10). */
export const COALESCE_MS = 150;

interface Timers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  now: Date.now,
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Coalesces `state` frames per socket (O10). A state frame is absolute, so only the latest matters: the first after a
 * quiet COALESCE_MS goes at once, and those that follow inside the window are held, the latest sent when it closes.
 * Any other frame (error, open) flushes the held state first, so frames never pass each other.
 * Invariant: a pending timer keeps a hibernatable object awake for at most COALESCE_MS; with no timer pending nothing
 * is held, so hibernation (which drops this in-memory map) loses nothing.
 */
export class StateCoalescer<W extends { send(text: string): void }> {
  private readonly slots = new Map<W, { sentAt: number; held: string | null; timer: unknown }>();

  constructor(private readonly timers: Timers = realTimers) {}

  state(ws: W, text: string): void {
    const now = this.timers.now();
    const slot = this.slots.get(ws);
    if (!slot || (slot.held === null && now - slot.sentAt >= COALESCE_MS)) {
      this.slots.set(ws, { sentAt: now, held: null, timer: null });
      safeSend(ws, text);
      return;
    }
    slot.held = text;
    slot.timer ??= this.timers.set(() => this.flush(ws), slot.sentAt + COALESCE_MS - now);
  }

  /** Any frame that must not be coalesced: the held state goes first. */
  other(ws: W, text: string): void {
    this.flush(ws);
    safeSend(ws, text);
  }

  /** Before closing a socket: its held state goes out, and its timer goes. */
  closing(ws: W): void {
    this.flush(ws);
    this.gone(ws);
  }

  /** The socket is already closed: drop what it held, send nothing. */
  gone(ws: W): void {
    const slot = this.slots.get(ws);
    if (slot?.timer != null) this.timers.clear(slot.timer);
    this.slots.delete(ws);
  }

  private flush(ws: W): void {
    const slot = this.slots.get(ws);
    if (!slot || slot.held === null) return;
    if (slot.timer != null) this.timers.clear(slot.timer);
    const text = slot.held;
    this.slots.set(ws, { sentAt: this.timers.now(), held: null, timer: null });
    safeSend(ws, text);
  }
}

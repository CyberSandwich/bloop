import { SILENCE_MS } from "../../../public/js/core/timing.js";

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
 * The address a link must come from (OPEN-02), read when the link is checked, so it never goes stale. A live authed
 * screen socket from the stored binding's address keeps it, whatever its age: a lectern that reconnects from the
 * bound address is the holder, not a younger rival to an older socket elsewhere. With none from there, the live
 * socket that verified first takes it (a leaked sid's later socket cannot take it from a screen still talking).
 * With none live, `stored`: the last verified proof, by `hello` or by poll.
 */
export function bindingIp(
  screens: readonly Screen[],
  now: number,
  stored: string | undefined,
  silenceMs = SILENCE_MS,
): string | undefined {
  const live = screens.filter((s) => holds(s, now, silenceMs));
  if (live.length === 0 || live.some((s) => s.ip === stored)) return stored;
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
 * A screen socket holds the binding until it closes or stays silent for the full silence window: a throttled
 * background tab pings late, so any shorter estimate would hand a live lectern's links to another address.
 */
const holds = (s: Screen, now: number, silenceMs: number): boolean => isLive(s.heardAt, now, silenceMs);

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
 * Slots are keyed by `keyOf`, not by the object: the runtime need not hand back the same wrapper for one socket from
 * getWebSockets() and a handler, so the Screen object keys on the attachment's id. A held frame goes to the latest
 * wrapper seen.
 */
export class StateCoalescer<W extends { send(text: string): void }> {
  private readonly slots = new Map<unknown, { ws: W; sentAt: number; held: string | null; timer: unknown }>();
  private readonly timers: Timers;
  private readonly keyOf: (ws: W) => unknown;

  constructor(opts: { timers?: Timers; keyOf?: (ws: W) => unknown } = {}) {
    this.timers = opts.timers ?? realTimers;
    this.keyOf = opts.keyOf ?? ((ws) => ws);
  }

  state(ws: W, text: string): void {
    const now = this.timers.now();
    const key = this.keyOf(ws);
    const slot = this.slots.get(key);
    if (!slot || (slot.held === null && now - slot.sentAt >= COALESCE_MS)) {
      this.slots.set(key, { ws, sentAt: now, held: null, timer: null });
      safeSend(ws, text);
      return;
    }
    slot.ws = ws;
    slot.held = text;
    slot.timer ??= this.timers.set(() => this.flush(key), slot.sentAt + COALESCE_MS - now);
  }

  /** Any frame that must not be coalesced: the held state goes first. */
  other(ws: W, text: string): void {
    this.flush(this.keyOf(ws));
    safeSend(ws, text);
  }

  /** Before closing a socket: its held state goes out, and its timer goes. */
  closing(ws: W): void {
    const key = this.keyOf(ws);
    this.flush(key);
    this.forget(key);
  }

  /** The socket is already closed: drop what it held, send nothing. */
  gone(ws: W): void {
    this.forget(this.keyOf(ws));
  }

  private forget(key: unknown): void {
    const slot = this.slots.get(key);
    if (slot?.timer != null) this.timers.clear(slot.timer);
    this.slots.delete(key);
  }

  private flush(key: unknown): void {
    const slot = this.slots.get(key);
    if (!slot || slot.held === null) return;
    if (slot.timer != null) this.timers.clear(slot.timer);
    const text = slot.held;
    this.slots.set(key, { ws: slot.ws, sentAt: this.timers.now(), held: null, timer: null });
    safeSend(slot.ws, text);
  }
}

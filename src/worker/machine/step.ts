// What the sub-reducers share: the step constructors, the clock units, a new session and how a session ends.
import type { EndReason, SessionState } from "../../shared/protocol.ts";
import type { FileItemRef, ItemRef } from "../items.ts";
import type { Effect, Machine, MachineConfig, MachineError, Step } from "../machine.ts";

export type Actor = "screen" | "phone" | "system";
export type Session = NonNullable<Machine["session"]>;

export const PRE_APPROVAL: readonly SessionState[] = ["claimed", "choosing", "uploading", "offered"];
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
/** An approved session that shows or fetches nothing in this long is a failed start (REL-16). */
export const START_SECONDS = 15;

/** A live pairing whose phone has not picked the match yet: every owner or guest action waits for it (PAIR-14). */
export const unconfirmed = (m: Machine): boolean => m.mode === "live" && m.pairing?.confirmed === false;

/**
 * The session's first sign of life: `startedAt` set once, and the one ok data point while the start was awaited. A
 * start after a recorded failure sets `startedAt` and writes nothing, so a session writes at most one point.
 */
export function withStart(session: Session, now: number): { session: Session; effects: Effect[] } {
  if (session.startedAt != null || session.approvedAt == null) return { session, effects: [] };
  const awaited = session.startBy != null;
  return {
    session: { ...session, startedAt: now, startBy: null },
    effects: awaited ? [{ fx: "start", ok: true, cause: null }] : [],
  };
}

export const ok = (next: Machine, effects: Effect[] = []): Step => ({ ok: true, next, effects });
export const fail = (error: MachineError): Step => ({ ok: false, error });
export const closeAtFor = (sockets: number, now: number, cfg: MachineConfig): number | null =>
  sockets === 0 ? now + cfg.closeAfterSeconds * SECOND : null;

/** A session nothing has happened in yet: not approved, nothing opened or shown. */
export const newSession = (items: ItemRef[], minted: number[]): Session => ({
  items,
  approvedAt: null,
  endsAt: null,
  openMode: null,
  firstOpenAt: null,
  minted,
  shown: null,
  seq: { phone: 0, screen: 0 },
});

export function codeRemovals(codes: Machine["codes"]): Effect[] {
  return [codes.current, codes.previous].flatMap((c) =>
    c ? [{ fx: "directory.remove" as const, code: c.value }] : [],
  );
}

/**
 * Residue.server for a guest object: by key once the session holds the file, by session id while an upload is
 * in flight (no ref yet). An owner session never stored anything, so it purges nothing.
 */
export function purgeEffects(m: Machine): Effect[] {
  if (m.state === "uploading") return [{ fx: "purge", file: null }];
  const guest = m.session?.items.find((i): i is FileItemRef => i.kind === "file" && i.source === "guest");
  if (!guest) return [];
  const { kind: _, id: __, ...file } = guest;
  return [{ fx: "purge", file }];
}

/** Terminal: both codes retired and storage deleted (`deleteAll` also releases a demo slot). No session, so no audit. */
export const close = (m: Machine): Step =>
  ok({ ...m, state: "closed", codes: { current: null, previous: null }, closeAt: null }, [
    ...codeRemovals(m.codes),
    { fx: "deleteAll" },
  ]);

export function endSession(m: Machine, now: number, cfg: MachineConfig, reason: EndReason, actor: Actor): Step {
  if (!m.pairing) return fail("wrong_state");
  const next: Machine = {
    ...m,
    state: "ended",
    codes: { current: null, previous: null },
    pairing: { ...m.pairing, listed: [], userId: null, phoneSession: null, passHash: null },
    session: null,
    upload: null,
    uploadAt: null,
    offerAt: null,
    endedAt: now,
    endReason: reason,
    closeAt: closeAtFor(m.sockets, now, cfg),
  };
  const effects: Effect[] = [...codeRemovals(m.codes)];
  if (m.session?.approvedAt != null) effects.push({ fx: "revokeLinks" });
  effects.push(...purgeEffects(m), { fx: "audit", type: "ended", actor });
  if (m.session?.approvedAt != null) {
    effects.push({ fx: "metric", name: "session_minutes", ms: now - m.session.approvedAt });
  }
  effects.push({ fx: "push", to: "both" });
  return ok(next, effects);
}

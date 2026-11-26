// Pure bodies of the Screen object's thin RPCs (interfaces.md section 2.4), so they are tested without an object.
import { fileById } from "../../items.ts";
import type { Effect, Event, Machine } from "../../machine.ts";

/** The end an owner's account action asks for: only when `userId` holds this screen's pairing and it has not ended. */
export const ownerEnd = (m: Machine | null, userId: string, now: number): Event | null =>
  m?.pairing && m.pairing.userId === userId && m.state !== "ended" ? { e: "end", now, by: "account" } : null;

/**
 * An account end is committed before its effects run, so a revoke that threw is retried by calling again. The end
 * dropped the pairing's user, so any caller re-runs it; revoking and pushing again is idempotent. An owner session
 * stored nothing, so there is no purge to repeat.
 */
export const accountEndRedo = (m: Machine | null): Effect[] =>
  m?.state === "ended" && m.endReason === "account" ? [{ fx: "revokeLinks" }, { fx: "push", to: "both" }] : [];

export interface Pinned {
  userId: string | null;
  sessionPublicId: string | null;
}

/** Whom the pairing is pinned to (ADR 0015), for the routes' cookie check. Null with no pairing. */
export const pinnedUser = (m: Machine | null): Pinned | null =>
  m?.pairing ? { userId: m.pairing.userId, sessionPublicId: m.pairing.phoneSession ?? null } : null;

/**
 * The approve gate (ADR 0015): the cookie user must be the pinned one, signed out included.
 * transitional: removed in P1 commit 5 (PAIR-15 auth-first holds only with sign-in configured; once the mock source
 * is no live default, a live pairing is always signed in and the signed-out match this lets through goes)
 */
export const cookieMismatch = (m: Machine | null, cookieUser: string | null): boolean =>
  !m?.pairing || m.pairing.userId !== cookieUser;

const NOTES_STATES: readonly Machine["state"][] = ["approved", "opening", "open"];

export interface NotesTarget {
  bucket: "LIBRARY";
  prefix: string;
  userId: string;
}

/**
 * Where an item's speaker notes live, from server state alone (NOTES-01): a library file of this approved session
 * whose conversion found notes, read as the pinned user. The route appends `/n/notes.json` to the version's prefix
 * (ADR 0013), which the bundle path cannot address. Any miss is null, and the route answers one 404.
 */
export function notesTarget(m: Machine | null, itemId: string): NotesTarget | null {
  const userId = m?.pairing?.userId;
  const session = m?.session;
  if (!m || !userId || !session || !NOTES_STATES.includes(m.state)) return null;
  const file = fileById(session.items, itemId);
  const extra = session.extra && Object.hasOwn(session.extra, itemId) ? session.extra[itemId] : undefined;
  if (file?.source !== "library" || extra?.notes !== true) return null;
  const [fileId, version] = file.ref.split(":");
  return { bucket: "LIBRARY", prefix: `u/${userId}/${fileId}/v${version}`, userId };
}

// Pure bodies of the Screen object's thin RPCs (interfaces.md section 2.4), so they are tested without an object.
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

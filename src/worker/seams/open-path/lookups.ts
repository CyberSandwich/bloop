// Pure bodies of the Screen object's thin RPCs (interfaces.md section 2.4), so they are tested without an object.
import type { Event, Machine } from "../../machine.ts";

/** The end an owner's account action asks for: only when `userId` holds this screen's pairing and it has not ended. */
export const ownerEnd = (m: Machine | null, userId: string, now: number): Event | null =>
  m?.pairing && m.pairing.userId === userId && m.state !== "ended" ? { e: "end", now, by: "system" } : null;

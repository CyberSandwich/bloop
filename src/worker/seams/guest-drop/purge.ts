// Deletion at every end of a session (DROP-07, RES-03): by the object's key when the session holds the file,
// else by session id (an upload still in flight has no ref yet). Audited as `guest.deleted` when an object existed.
import type { AuditLog } from "../../audit.ts";
import { bestEffort } from "../../do/effects.ts";
import type { FileRef } from "../../machine.ts";
import type { GuestDrop } from "./index.ts";

export interface PurgeDeps {
  drop: Pick<GuestDrop, "purge">;
  audit: Pick<AuditLog, "record">;
  now(): number;
  /** Ends the session's live conversion first, so a put in flight cannot land after the delete below. */
  cancelConversion?(sessionId: string): Promise<void>;
}

/**
 * Never throws: a failed delete is logged and left for the hourly sweep and the lifecycle rule, and must not
 * stop the session from ending.
 */
export async function purgeGuest(
  deps: PurgeDeps,
  input: { sessionId: string | null; file: FileRef | null },
): Promise<void> {
  const { sessionId, file } = input;
  if (file && file.source !== "guest") return;
  try {
    if (sessionId) await deps.cancelConversion?.(sessionId).catch(() => console.error("guest_cancel_failed"));
    const deleted = await deps.drop.purge(sessionId, file?.ref ?? null);
    if (deleted && sessionId) {
      await bestEffort(
        deps.audit.record({
          sessionId,
          at: deps.now(),
          actor: "system",
          type: "guest.deleted",
          detail: { source: "guest" },
        }),
      );
    }
  } catch {
    console.error("guest_delete_failed");
  }
}

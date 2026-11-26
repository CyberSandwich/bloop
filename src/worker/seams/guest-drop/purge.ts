// Deletion at every end of a session (DROP-07, RES-03): the session's open uploads are aborted, then its object goes,
// by its key when the session holds the file, else by session id (an upload still in flight has no ref yet). Audited
// as `guest.deleted` when an object existed.
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
  /** Closes the session's open uploads and aborts their multiparts (uploads/guest.ts `abortSession`). */
  abortUploads(sessionId: string): Promise<unknown>;
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
    // Before the files: no multipart may outlive its session, and one aborted here can join no object later.
    if (sessionId) await deps.abortUploads(sessionId).catch(() => console.error("guest_abort_failed"));
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

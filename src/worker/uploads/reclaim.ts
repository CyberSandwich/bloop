// The ordering rule, wherever bytes and quota meet: the guarded D1 move (a release, a guest close, a refusal) runs
// first, and R2's object and multipart go only when that move won. A loser deletes nothing, because the winner may
// have settled a live file under the same key. The one other R2 delete or abort in src/worker/uploads/ is create's undo
// of a multipart no row names (test/unit/uploads-guard.test.ts holds that).
//
// Trap: a Worker that dies between the move and the delete leaves a joined object nothing counts. The closed rows
// still name its key, so the hourly sweep (`strandStep`, the one delete outside this file) repeats the delete.
import type { Multipart } from "./multipart.ts";

/** What R2 holds for a row: the object key, and the multipart id while one may still be open. */
export interface Held {
  r2Key: string;
  r2UploadId?: string;
}

/** Runs `move`; when it won, aborts the multipart (if any) and deletes the object. True: the move won. */
export async function reclaim(mp: Multipart, held: Held, move: () => Promise<boolean>): Promise<boolean> {
  if (!(await move())) return false;
  if (held.r2UploadId) await mp.abort(held.r2Key, held.r2UploadId);
  await mp.delete(held.r2Key).catch(() => {});
  return true;
}

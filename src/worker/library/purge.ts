// Due files, purged in two passes (LIB-08, ADR 0016). The R2 prefix is listed and emptied, never read back from D1, so
// keys nobody recorded go too. Bytes go before rows: a crash leaves a row over an empty prefix, which the next run clears.
import { bucketOf, type LibraryBucket } from "./bucket.ts";
import { libDbOf } from "./store.ts";

/** The longest a conversion can still write after it was cancelled: its lease plus a minute. Pass 2 waits this long. */
export const LATE_WRITE_WINDOW_MS = 1_860_000;
const LIST_PAGE = 1000;
const ROW_BATCH = 50;

/** How much R2 listing one run may do, so a run ends inside the Worker's limits and the rest waits for the next. */
export interface Budget {
  rounds: number;
}

export const filePrefix = (userId: string, fileId: string): string => `u/${userId}/${fileId}/`;

/** Empties `prefix` in rounds of 1,000. True when the budget ran out with keys possibly left. */
export async function deletePrefix(bucket: LibraryBucket, prefix: string, budget: Budget): Promise<boolean> {
  while (budget.rounds > 0) {
    const page = await bucket.list({ prefix, limit: LIST_PAGE });
    if (page.objects.length === 0) return false;
    await bucket.delete(page.objects.map((o) => o.key));
    budget.rounds--;
  }
  return true;
}

interface Due {
  id: string;
  user_id: string;
  bytes: number;
  status: string;
}

export interface PurgeDeps {
  /** V2's stop for a running conversion of this file. */
  cancelConversion(fileId: string): Promise<void>;
  /** Whether the user's export lease is live: such a user's files stay until it ends. */
  exporting(userId: string): Promise<boolean>;
  now(): number;
}

export interface PurgeReport {
  purged: number;
  more: boolean;
  /** Owners whose bytes were released, so their open pages can refetch the quota. */
  freed: string[];
}

/**
 * Pass 1 releases the owner's bytes once and marks the row `purged` with a later due time; pass 2, once that time
 * passes, empties the prefix again (a put already awaiting during pass 1 can still land) and deletes the rows. A racing
 * run finds the status already `purged`, so the bytes drop once (LIB-02 race). Suspended and purging owners are skipped,
 * and so is an owner with a live export, whose snapshot must stay readable.
 */
export async function purgeDueFiles(
  env: { DB: unknown; LIBRARY: unknown },
  options: { userId?: string; budget: Budget },
  deps: PurgeDeps,
): Promise<PurgeReport> {
  const db = libDbOf(env.DB);
  const now = deps.now();
  const owner = options.userId !== undefined;
  const { results } = await db
    .prepare(
      `SELECT f.id, f.user_id, f.bytes, f.status FROM library_file f JOIN app_user u ON u.id = f.user_id
       WHERE f.purge_after IS NOT NULL AND f.purge_after <= ?1 AND u.suspended_at IS NULL AND u.status != 'purging'
         ${owner ? "AND f.user_id = ?3" : ""} ORDER BY f.purge_after, f.id LIMIT ?2`,
    )
    .bind(now, ROW_BATCH, ...(owner ? [options.userId] : []))
    .all<Due>();
  const report: PurgeReport = { purged: 0, more: results.length === ROW_BATCH, freed: [] };
  const exporting = new Map<string, boolean>();
  for (const row of results) {
    let busy = exporting.get(row.user_id);
    if (busy === undefined) {
      busy = await deps.exporting(row.user_id);
      exporting.set(row.user_id, busy);
    }
    if (busy) continue;
    if (row.status !== "purged") await deps.cancelConversion(row.id);
    if (await deletePrefix(bucketOf(env.LIBRARY), filePrefix(row.user_id, row.id), options.budget))
      return { ...report, more: true };
    if (row.status === "purged") {
      await db.batch([
        db.prepare("DELETE FROM derived WHERE file_id = ?1").bind(row.id),
        db
          .prepare(
            "DELETE FROM library_file WHERE user_id = ?1 AND id = ?2 AND status = 'purged' AND purge_after <= ?3",
          )
          .bind(row.user_id, row.id, now),
      ]);
    } else {
      await db.batch([
        db
          .prepare(
            `UPDATE app_user SET used_bytes = MAX(used_bytes - ?1, 0) WHERE id = ?2 AND EXISTS (
               SELECT 1 FROM library_file WHERE user_id = ?2 AND id = ?3 AND status IN ('checking', 'ready') AND purge_after <= ?4)`,
          )
          .bind(row.bytes, row.user_id, row.id, now),
        db
          .prepare(
            "UPDATE library_file SET status = 'purged', purge_after = ?4 WHERE user_id = ?1 AND id = ?2 AND status != 'purged' AND purge_after <= ?3",
          )
          .bind(row.user_id, row.id, now, now + LATE_WRITE_WINDOW_MS),
      ]);
      report.freed.push(row.user_id);
    }
    report.purged++;
  }
  return report;
}

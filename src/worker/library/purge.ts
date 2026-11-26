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

const MAX_SELECTS = 5;
const MAX_SKIPPED = 90;

/** A live hold whose copy is not yet made: the bytes must stay until `copied_at` is set (OSA-02). */
export const PENDING_HOLD_SQL = "release_after > ?2 AND copied_at IS NULL";

/** Whether this file, or any file of this owner, has a pending hold. */
export async function holdPending(env: { DB: unknown }, where: "file" | "owner", id: string, now: number) {
  const row = await libDbOf(env.DB)
    .prepare(
      `SELECT 1 AS n FROM hold WHERE ${where === "file" ? "file_id" : "owner_user_id"} = ?1 AND ${PENDING_HOLD_SQL} LIMIT 1`,
    )
    .bind(id, now)
    .first<{ n: number }>();
  return row !== null;
}

/**
 * The due rows a run may act on. An owner with a live export, or a file whose hold copy is pending, is left out of the
 * query and the window refilled, so one such owner can never fill the window and starve the rest.
 */
async function dueBatch(
  env: { DB: unknown; LIBRARY: unknown },
  userId: string | undefined,
  now: number,
  deps: PurgeDeps,
): Promise<{ batch: Due[]; full: boolean }> {
  const db = libDbOf(env.DB);
  const skipUsers = new Set<string>();
  const skipFiles = new Set<string>();
  const cleared = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    const fixed = userId === undefined ? 2 : 3;
    const users = [...skipUsers];
    const files = [...skipFiles];
    const marks = (from: number, n: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(", ");
    const { results } = await db
      .prepare(
        `SELECT f.id, f.user_id, f.bytes, f.status FROM library_file f JOIN app_user u ON u.id = f.user_id
         WHERE f.purge_after IS NOT NULL AND f.purge_after <= ?1 AND u.suspended_at IS NULL AND u.status != 'purging'
           ${userId === undefined ? "" : "AND f.user_id = ?3"}
           ${users.length ? `AND f.user_id NOT IN (${marks(fixed + 1, users.length)})` : ""}
           ${files.length ? `AND f.id NOT IN (${marks(fixed + 1 + users.length, files.length)})` : ""}
         ORDER BY f.purge_after, f.id LIMIT ?2`,
      )
      .bind(now, ROW_BATCH, ...(userId === undefined ? [] : [userId]), ...users, ...files)
      .all<Due>();
    const batch: Due[] = [];
    for (const row of results) {
      if (!cleared.has(row.user_id) && (await deps.exporting(row.user_id))) {
        skipUsers.add(row.user_id);
        continue;
      }
      cleared.add(row.user_id);
      if (row.status !== "purged" && (await holdPending(env, "file", row.id, now))) {
        skipFiles.add(row.id);
        continue;
      }
      batch.push(row);
    }
    const full = results.length === ROW_BATCH;
    const skipped = skipUsers.size + skipFiles.size;
    if (batch.length === results.length || !full || attempt === MAX_SELECTS || skipped > MAX_SKIPPED) {
      return { batch, full: full && batch.length > 0 };
    }
  }
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
  const { batch, full } = await dueBatch(env, options.userId, now, deps);
  const report: PurgeReport = { purged: 0, more: full, freed: [] };
  for (const row of batch) {
    if (row.status === "purged") {
      if (await deletePrefix(bucketOf(env.LIBRARY), filePrefix(row.user_id, row.id), options.budget))
        return { ...report, more: true };
      await db.batch([
        db.prepare("DELETE FROM derived WHERE file_id = ?1 AND owner_kind = 'library'").bind(row.id),
        db
          .prepare(
            "DELETE FROM library_file WHERE user_id = ?1 AND id = ?2 AND status = 'purged' AND purge_after <= ?3",
          )
          .bind(row.user_id, row.id, now),
      ]);
      report.purged++;
      continue;
    }
    await deps.cancelConversion(row.id);
    // The claim comes before any byte goes, and it refuses a file whose hold row was inserted since the batch was read:
    // a hold that starts after the claim finds the row `purged` and reports the file missing instead (hold.ts).
    const [, marked] = await db.batch([
      db
        .prepare(
          `UPDATE app_user SET used_bytes = MAX(used_bytes - ?1, 0) WHERE id = ?2 AND EXISTS (
             SELECT 1 FROM library_file WHERE user_id = ?2 AND id = ?3 AND status IN ('checking', 'ready') AND purge_after <= ?4)
             AND NOT EXISTS (SELECT 1 FROM hold WHERE file_id = ?3 AND release_after > ?4 AND copied_at IS NULL)`,
        )
        .bind(row.bytes, row.user_id, row.id, now),
      db
        .prepare(
          `UPDATE library_file SET status = 'purged', purge_after = ?4 WHERE user_id = ?1 AND id = ?2 AND status != 'purged'
             AND purge_after <= ?3 AND NOT EXISTS (SELECT 1 FROM hold WHERE file_id = ?2 AND release_after > ?3 AND copied_at IS NULL)`,
        )
        .bind(row.user_id, row.id, now, now + LATE_WRITE_WINDOW_MS),
    ]);
    if (!marked || marked.meta.changes === 0) continue;
    report.freed.push(row.user_id);
    report.purged++;
    if (await deletePrefix(bucketOf(env.LIBRARY), filePrefix(row.user_id, row.id), options.budget))
      return { ...report, more: true };
  }
  return report;
}

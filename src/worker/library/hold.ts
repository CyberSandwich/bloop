// The NCA hold (OSA-02, LIB-11): a reported file is copied to the library bucket under `h/<holdId>`, outside the user's
// prefix and every purge. The `hold` row is written once the source is known to exist and is pending (`copied_at` NULL)
// until the copy is made, so a copy is never untracked and the purge claim refuses a file whose copy is pending. Never
// the guest bucket: its one-day expiry is bucket-wide.
import { newRef } from "../ids.ts";
import { bucketOf, type LibraryBucket } from "./bucket.ts";
import { libDbOf } from "./store.ts";

const YEAR_MS = 365 * 86_400_000;
/** One call copies at most this many; the caller loops while `more`. */
export const HOLD_BATCH = 10;
const RELEASE_BATCH = 50;

export type HoldTarget =
  | { fileIds: readonly string[] }
  /** Every file the user created in [from, to]: the window form of regulation 8(2). */
  | { userId: string; from: number; to: number };

interface Source {
  fileId: string;
  ownerId: string | null;
  bucket: "library" | "guest";
  key: string;
  sha256: string | null;
}

export const holdKey = (holdId: string): string => `h/${holdId}`;

/** `absent` are named ids with no readable source: a purged or unknown file. */
async function sourcesOf(
  db: ReturnType<typeof libDbOf>,
  target: HoldTarget,
): Promise<{ sources: Source[]; absent: string[] }> {
  if ("fileIds" in target) {
    const found: Source[] = [];
    const absent: string[] = [];
    for (const id of target.fileIds) {
      const lib = await db
        .prepare("SELECT id, user_id, r2_key, sha256 FROM library_file WHERE id = ?1 AND status != 'purged'")
        .bind(id)
        .first<{
          id: string;
          user_id: string;
          r2_key: string;
          sha256: string | null;
        }>();
      if (lib) {
        found.push({
          fileId: lib.id,
          ownerId: lib.user_id,
          bucket: "library",
          key: lib.r2_key,
          sha256: lib.sha256,
        });
        continue;
      }
      const guest = await db
        .prepare("SELECT session_id, r2_key, sha256 FROM guest_file WHERE session_id = ?1 AND deleted_at IS NULL")
        .bind(id)
        .first<{ session_id: string; r2_key: string; sha256: string }>();
      if (guest) {
        found.push({
          fileId: guest.session_id,
          ownerId: null,
          bucket: "guest",
          key: guest.r2_key,
          sha256: guest.sha256,
        });
      } else {
        absent.push(id);
      }
    }
    return { sources: found, absent };
  }
  const { results } = await db
    .prepare(
      `SELECT id, user_id, r2_key, sha256 FROM library_file WHERE user_id = ?1 AND created_at >= ?2 AND created_at <= ?3
         AND status != 'purged' ORDER BY created_at, id`,
    )
    .bind(target.userId, target.from, target.to)
    .all<{
      id: string;
      user_id: string;
      r2_key: string;
      sha256: string | null;
    }>();
  return {
    sources: results.map((r) => ({
      fileId: r.id,
      ownerId: r.user_id,
      bucket: "library",
      key: r.r2_key,
      sha256: r.sha256,
    })),
    absent: [],
  };
}

export interface HoldReport {
  /** Files with a live hold after this call whose copy is in place. */
  held: { fileId: string; holdId: string }[];
  /** Files named but not found, or whose source object is gone. */
  missing: string[];
  more: boolean;
}

/**
 * Holds up to ten files for a report. A file already held for the same report is not held twice, and a hold whose copy
 * is missing is copied again, so a retried call finishes what a crashed one began.
 */
export async function holdFiles(
  env: { DB: unknown; LIBRARY: unknown; GUEST_FILES: unknown },
  options: { reportId: string; target: HoldTarget },
  now: number,
  newId: () => string = newRef,
): Promise<HoldReport> {
  const db = libDbOf(env.DB);
  const buckets: Record<Source["bucket"], LibraryBucket> = {
    library: bucketOf(env.LIBRARY),
    guest: bucketOf(env.GUEST_FILES),
  };
  const { sources, absent } = await sourcesOf(db, options.target);
  const report: HoldReport = { held: [], missing: [], more: false };
  // A file already purged stays held when its copy was made; any other named id is reported, never dropped.
  for (const id of absent) {
    const existing = await db
      .prepare("SELECT id FROM hold WHERE file_id = ?1 AND report_id = ?2")
      .bind(id, options.reportId)
      .first<{ id: string }>();
    if (existing && (await buckets.library.head(holdKey(existing.id)))) {
      report.held.push({ fileId: id, holdId: existing.id });
    } else {
      report.missing.push(id);
    }
  }
  let copies = 0;
  for (const source of sources) {
    const existing = await db
      .prepare("SELECT id, copied_at FROM hold WHERE file_id = ?1 AND report_id = ?2")
      .bind(source.fileId, options.reportId)
      .first<{ id: string; copied_at: number | null }>();
    if (existing && existing.copied_at !== null && (await buckets.library.head(holdKey(existing.id)))) {
      report.held.push({ fileId: source.fileId, holdId: existing.id });
      continue;
    }
    if (copies === HOLD_BATCH) {
      report.more = true;
      break;
    }
    // The source is read first: a file with nothing to copy leaves no row, since a pending row stops its purge.
    const original = await buckets[source.bucket].get(source.key);
    if (!original) {
      if (existing) await db.prepare("DELETE FROM hold WHERE id = ?1").bind(existing.id).run();
      report.missing.push(source.fileId);
      continue;
    }
    const holdId = existing?.id ?? newId();
    // The row is pending (`copied_at` NULL) from here until the copy exists, and the purge claim refuses a pending file.
    if (existing) {
      await db.prepare("UPDATE hold SET copied_at = NULL WHERE id = ?1").bind(holdId).run();
    } else {
      await db
        .prepare(
          `INSERT INTO hold (id, file_id, owner_user_id, bucket, r2_key, sha256, report_id, created_at, release_after)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          holdId,
          source.fileId,
          source.ownerId,
          "library",
          holdKey(holdId),
          source.sha256,
          options.reportId,
          now,
          now + YEAR_MS,
        )
        .run();
    }
    try {
      await buckets.library.put(holdKey(holdId), original.body);
    } catch {
      // A purge claimed the file after the read and its bytes went mid-copy: nothing is held, and no row may say so.
      await db.prepare("DELETE FROM hold WHERE id = ?1").bind(holdId).run();
      report.missing.push(source.fileId);
      continue;
    }
    await db.prepare("UPDATE hold SET copied_at = ?2 WHERE id = ?1").bind(holdId, now).run();
    copies++;
    report.held.push({ fileId: source.fileId, holdId });
  }
  return report;
}

/** Holds past their release time: the copy first, then the row, so a crash leaves a row that names the copy. */
export async function releaseHolds(
  env: { DB: unknown; LIBRARY: unknown },
  now: number,
): Promise<{ released: number; more: boolean }> {
  const db = libDbOf(env.DB);
  const bucket = bucketOf(env.LIBRARY);
  const { results } = await db
    .prepare("SELECT id FROM hold WHERE release_after <= ?1 ORDER BY release_after LIMIT ?2")
    .bind(now, RELEASE_BATCH)
    .all<{ id: string }>();
  for (const { id } of results) {
    await bucket.delete(holdKey(id));
    await db.prepare("DELETE FROM hold WHERE id = ?1").bind(id).run();
  }
  return { released: results.length, more: results.length === RELEASE_BATCH };
}

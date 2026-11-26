// The account purge (ADR 0013, steps 0 to 5) and its two backstops: a second prefix delete once a tombstone passes its
// resweep time, and the scan for prefixes whose owner row is gone. Idempotent and resumable: a crash leaves a `purging`
// row that names what is still to delete, and rows go last (LIB-08). Only keys under `u/<uid>/` are ever listed or
// deleted: holds (`h/`) and tombstones (`purged/`) sit outside it (OSA-02).
import { type Db, dbOf } from "../auth/db.ts";
import { bucketOf } from "./bucket.ts";
import { type Budget, deletePrefix, holdPending, LATE_WRITE_WINDOW_MS, type PurgeDeps } from "./purge.ts";
import { libDbOf } from "./store.ts";

const MARKS_PER_STATEMENT = 90;

export interface AccountPurgeDeps extends PurgeDeps {
  /** The user's live screens end (P1's Screen end, through the user object). */
  endScreens(userId: string): Promise<void>;
  /** Sockets of ended sessions close at once. */
  closeSessions(userId: string, publicIds: string[]): Promise<void>;
  /** U's abort of every open upload. True when one was claimed within 120 s: stop, the next run continues. */
  abortUploads(userId: string): Promise<boolean>;
  /** The user object's `purge()`: its sockets close and its storage goes. */
  eraseObject(userId: string): Promise<void>;
}

export type AccountPurge = "purged" | "more" | "skipped";

const prefixOf = (userId: string) => `u/${userId}/`;
const tombstone = (userId: string) => `purged/${userId}`;

/**
 * Purges one user. `skipped` is a user the claim refused (not due, suspended, or with a hold whose copy is pending). `more` ran out of
 * budget or met an upload still settling; the row stays `purging` and the next run continues.
 */
export async function purgeUser(
  env: { DB: unknown; LIBRARY: unknown },
  userId: string,
  budget: Budget,
  deps: AccountPurgeDeps,
): Promise<AccountPurge> {
  const db = libDbOf(env.DB);
  const bucket = bucketOf(env.LIBRARY);
  const now = deps.now();
  // Step 0: the claim. From here no sign-in, restore or reserve can succeed; a row already purging continues.
  await db
    .prepare(
      `UPDATE app_user SET status = 'purging' WHERE id = ?1 AND delete_after <= ?2 AND status IN ('active', 'deleting')
         AND suspended_at IS NULL AND NOT EXISTS (SELECT 1 FROM hold WHERE owner_user_id = ?1 AND release_after > ?2 AND copied_at IS NULL)`,
    )
    .bind(userId, now)
    .run();
  const row = await db.prepare("SELECT status FROM app_user WHERE id = ?1").bind(userId).first<{ status: string }>();
  if (row?.status !== "purging") return "skipped";

  // Step 1: screens end, then every session goes and its sockets close.
  await deps.endScreens(userId);
  const sessions = (
    await db
      .prepare("SELECT public_id FROM phone_session WHERE user_id = ?1")
      .bind(userId)
      .all<{ public_id: string | null }>()
  ).results.flatMap((r) => (r.public_id === null ? [] : [r.public_id]));
  await db.prepare("DELETE FROM phone_session WHERE user_id = ?1").bind(userId).run();
  await deps.closeSessions(userId, sessions);

  // Step 2: open uploads. One claimed within 120 s settles on its own and refuses a purging owner.
  if (await deps.abortUploads(userId)) return "more";

  // Step 3: conversions still queued or running for this user's files stop before their prefix is emptied.
  const running = await db
    .prepare(
      `SELECT f.id FROM library_file f JOIN derived d ON d.file_id = f.id AND d.version = f.version
       WHERE f.user_id = ?1 AND d.status IN ('queued', 'running')`,
    )
    .bind(userId)
    .all<{ id: string }>();
  for (const f of running.results) await deps.cancelConversion(f.id);

  // Step 4: bytes, then derived rows, then the user object. A hold placed after the claim waits for its copy first.
  if (await holdPending(env, "owner", userId, now)) return "more";
  if (await deletePrefix(bucket, prefixOf(userId), budget)) return "more";
  await db
    .prepare("DELETE FROM derived WHERE file_id IN (SELECT id FROM library_file WHERE user_id = ?1)")
    .bind(userId)
    .run();
  await deps.eraseObject(userId);

  // Step 5: the tombstone first (a repeat rewrites it), then invite and waitlist rows by address and the user row.
  await bucket.put(tombstone(userId), JSON.stringify({ purgedAt: now, resweepAfter: now + LATE_WRITE_WINDOW_MS }));
  await db.batch([
    db
      .prepare(
        "DELETE FROM invite WHERE email_norm = (SELECT email_norm FROM app_user WHERE id = ?1 AND status = 'purging')",
      )
      .bind(userId),
    db
      .prepare(
        "DELETE FROM waitlist WHERE email_norm = (SELECT email_norm FROM app_user WHERE id = ?1 AND status = 'purging')",
      )
      .bind(userId),
    db.prepare("DELETE FROM app_user WHERE id = ?1 AND status = 'purging'").bind(userId),
  ]);
  return "purged";
}

/** Users due now: rows already `purging` first, since they were claimed and must finish. */
export async function dueUsers(env: { DB: unknown }, now: number, limit: number): Promise<string[]> {
  const { results } = await dbOf(env.DB)
    .prepare(
      `SELECT id FROM app_user WHERE status = 'purging'
         OR (delete_after IS NOT NULL AND delete_after <= ?1 AND status IN ('active', 'deleting') AND suspended_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM hold WHERE owner_user_id = app_user.id AND release_after > ?1 AND copied_at IS NULL))
       ORDER BY status = 'purging' DESC, delete_after LIMIT ?2`,
    )
    .bind(now, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

interface Tombstone {
  purgedAt: number;
  resweepAfter: number;
}

/** A background scan resumes where it stopped: its list cursor lives in `setting`, and none means start over. */
const RESWEEP_CURSOR = "library_resweep_cursor";
const ORPHAN_CURSOR = "library_orphan_cursor";
const TOMBSTONES_PER_RUN = 100;
/** One round pays for this many tombstone reads, so the reads count against the run's budget like the deletes do. */
const READS_PER_ROUND = 25;

async function readCursor(db: Db, key: string): Promise<string | undefined> {
  const row = await db.prepare("SELECT value FROM setting WHERE key = ?1").bind(key).first<{ value: string }>();
  return row?.value;
}

async function writeCursor(db: Db, key: string, cursor: string | undefined, now: number): Promise<void> {
  if (cursor === undefined) {
    await db.prepare("DELETE FROM setting WHERE key = ?1").bind(key).run();
    return;
  }
  await db
    .prepare("INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?1, ?2, ?3)")
    .bind(key, cursor, now)
    .run();
}

/**
 * Deletes `u/<uid>/` once more for each tombstone past its resweep time, catching a put that was awaiting at purge time,
 * then deletes the tombstone. A run reads one page of tombstones from where the last stopped.
 */
export async function resweepTombstones(
  env: { DB: unknown; LIBRARY: unknown },
  budget: Budget,
  now: number,
): Promise<{ swept: number; more: boolean }> {
  const db = dbOf(env.DB);
  const bucket = bucketOf(env.LIBRARY);
  const cursor = await readCursor(db, RESWEEP_CURSOR);
  const page = await bucket.list({
    prefix: "purged/",
    limit: TOMBSTONES_PER_RUN,
    ...(cursor ? { cursor } : {}),
  });
  budget.rounds -= Math.ceil(page.objects.length / READS_PER_ROUND);
  let swept = 0;
  for (const { key } of page.objects) {
    const body = await bucket.get(key);
    const mark = body ? (JSON.parse(await body.text()) as Tombstone) : null;
    if (!mark || mark.resweepAfter > now) continue;
    if (await deletePrefix(bucket, prefixOf(key.slice("purged/".length)), budget)) return { swept, more: true };
    await bucket.delete(key);
    swept++;
  }
  await writeCursor(db, RESWEEP_CURSOR, page.truncated ? page.cursor : undefined, now);
  return { swept, more: page.truncated };
}

/**
 * Prefixes under `u/` whose owner row is gone (a purge that crashed after its row went): emptied like step 4. A run reads
 * one page of prefixes from where the last stopped.
 */
export async function sweepOrphans(
  env: { DB: unknown; LIBRARY: unknown },
  budget: Budget,
  now: number,
): Promise<{ orphans: number; more: boolean }> {
  const db: Db = dbOf(env.DB);
  const bucket = bucketOf(env.LIBRARY);
  const cursor = await readCursor(db, ORPHAN_CURSOR);
  const page = await bucket.list({
    prefix: "u/",
    delimiter: "/",
    limit: 1000,
    ...(cursor ? { cursor } : {}),
  });
  const uids = page.delimitedPrefixes.map((p) => p.slice("u/".length, -1));
  let orphans = 0;
  for (let i = 0; i < uids.length; i += MARKS_PER_STATEMENT) {
    const part = uids.slice(i, i + MARKS_PER_STATEMENT);
    const { results } = await db
      .prepare(`SELECT id FROM app_user WHERE id IN (${part.map((_, j) => `?${j + 1}`).join(", ")})`)
      .bind(...part)
      .all<{ id: string }>();
    const live = new Set(results.map((r) => r.id));
    for (const uid of part.filter((u) => !live.has(u))) {
      if (await deletePrefix(bucket, prefixOf(uid), budget)) return { orphans, more: true };
      orphans++;
    }
  }
  await writeCursor(db, ORPHAN_CURSOR, page.truncated ? page.cursor : undefined, now);
  return { orphans, more: page.truncated };
}

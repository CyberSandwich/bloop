// The library quota moves (ADR 0013, LIB-02): reserve at create, settle at complete, release at abort or expiry,
// refuse after a failed check, reconcile nightly. Each move is one D1 batch (one transaction), and each statement is
// guarded by the row it moves, so a repeat or a race changes nothing twice. Nothing else may write `reserved_bytes`
// or `used_bytes`.
//
// Invariant: for each user, `reserved_bytes` is the sum of their open library uploads' bytes and `used_bytes` the sum of
// their `checking` and `ready` files', and `used + reserved <= quota` after every committed batch.
import type { BatchDb, Db } from "../auth/db.ts";
import {
  CLAIM_MS,
  claimFree,
  INSERT_COLUMNS,
  INSERT_PLACEHOLDERS,
  insertValues,
  live,
  type NewUpload,
  OPEN,
} from "./store.ts";

export interface Limits {
  /** LIBRARY_QUOTA_BYTES: the default for a user with no override. */
  quotaBytes: number;
  maxFiles: number;
}

export type ReserveRefusal = "quota_exceeded" | "library_full" | "upload_gone" | "upload_busy" | "twin";

/** A library file that takes a slot under `maxFiles`: a refused one does not, a trashed one does until it is purged. */
const COUNTED_FILE = "status IN ('checking', 'ready')";
/** A reserve refused for a reason that is gone when read is tried again this many times in all. */
const RESERVE_TRIES = 3;

/**
 * Reserves `n.bytes` and inserts the upload row in one batch. The insert carries every guard: the owner is active and
 * not suspended, the bytes fit what remains of the quota, the file count stays under the cap (live uploads count,
 * since each becomes a file), and no live upload of the same fingerprint exists (a double tap). `n.createdAt` is the
 * now of the live tests. Zero inserts means a refusal, and nothing changed. Returns the refusal, or null when reserved.
 */
export async function reserveLibrary(db: BatchDb, n: NewUpload, limits: Limits): Promise<ReserveRefusal | null> {
  if (n.owner.kind !== "library") throw new TypeError("a library upload needs a user");
  const { userId } = n.owner;
  for (let tries = 0; tries < RESERVE_TRIES; tries++) {
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO upload (${INSERT_COLUMNS}) SELECT ${INSERT_PLACEHOLDERS()} FROM app_user
           WHERE id = ?19 AND status = 'active' AND suspended_at IS NULL
             AND used_bytes + reserved_bytes + ?12 <= COALESCE(quota_bytes, ?20)
             AND (SELECT count(*) FROM library_file WHERE user_id = ?19 AND ${COUNTED_FILE})
               + (SELECT count(*) FROM upload WHERE user_id = ?19 AND ${live(16)}) < ?21
             AND NOT EXISTS (SELECT 1 FROM upload WHERE user_id = ?19 AND fingerprint = ?15 AND ${live(16)})`,
        )
        .bind(...insertValues(n), userId, limits.quotaBytes, limits.maxFiles),
      db
        .prepare(
          "UPDATE app_user SET reserved_bytes = reserved_bytes + ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM upload WHERE id = ?3)",
        )
        .bind(n.bytes, userId, n.id),
    ]);
    if (inserted && inserted.meta.changes > 0) return null;
    const why = await whyRefused(db, userId, n, limits);
    if (why) return why;
  }
  return "upload_busy";
}

/**
 * The cheap read of reserve's guards: the refusal a reserve would meet at `now`, or null. It is a courtesy, never the
 * guard: reserve re-checks everything in its own batch.
 */
export async function precheckLibrary(
  db: Db,
  userId: string,
  bytes: number,
  limits: Limits,
  now: number,
): Promise<Exclude<ReserveRefusal, "twin" | "upload_busy"> | null> {
  const user = await db
    .prepare(
      `SELECT status, suspended_at AS suspendedAt, used_bytes + reserved_bytes + ?2 <= COALESCE(quota_bytes, ?3) AS fits,
         (SELECT count(*) FROM library_file WHERE user_id = ?1 AND ${COUNTED_FILE})
           + (SELECT count(*) FROM upload WHERE user_id = ?1 AND ${live(4)}) AS files
       FROM app_user WHERE id = ?1`,
    )
    .bind(userId, bytes, limits.quotaBytes, now)
    .first<{ status: string; suspendedAt: number | null; fits: number; files: number }>();
  if (user?.status !== "active" || user.suspendedAt !== null) return "upload_gone";
  if (!user.fits) return "quota_exceeded";
  return user.files >= limits.maxFiles ? "library_full" : null;
}

/** What stopped a reserve, read after the fact: a twin first (the answer is the resume), then the first guard that fails now; null when none does. */
async function whyRefused(db: BatchDb, userId: string, n: NewUpload, limits: Limits): Promise<ReserveRefusal | null> {
  const twin = await db
    .prepare(`SELECT 1 AS one FROM upload WHERE user_id = ?1 AND fingerprint = ?2 AND ${live(3)}`)
    .bind(userId, n.fingerprint, n.createdAt)
    .first();
  return twin ? "twin" : precheckLibrary(db, userId, n.bytes, limits, n.createdAt);
}

/**
 * Complete's settle, under its claim: the library file appears as `checking`, the bytes move from reserved to used,
 * the upload closes. Guarded by the claim, the row still open and the owner active and not suspended, so a stale or
 * concurrent settle, and a purge that took the user meanwhile, change nothing. True: settled.
 */
export async function settleLibrary(
  db: BatchDb,
  u: { id: string; userId: string; fileId: string; bytes: number },
  claimToken: number,
  now: number,
): Promise<boolean> {
  const held = `EXISTS (SELECT 1 FROM upload WHERE id = ?1 AND completing_at = ?2 AND ${OPEN})`;
  const [, , closed] = await db.batch([
    db
      .prepare(
        `INSERT INTO library_file (id, user_id, name, ext, bytes, version, r2_key, status, created_at, updated_at)
         SELECT u.file_id, u.user_id, u.name, u.ext, u.bytes, 1, u.r2_key, 'checking', ?3, ?3
         FROM upload u JOIN app_user a ON a.id = u.user_id
         WHERE u.id = ?1 AND u.completing_at = ?2 AND u.completed_at IS NULL AND u.aborted_at IS NULL
           AND a.status = 'active' AND a.suspended_at IS NULL`,
      )
      .bind(u.id, claimToken, now),
    db
      .prepare(
        `UPDATE app_user SET reserved_bytes = reserved_bytes - ?3, used_bytes = used_bytes + ?3
         WHERE id = ?4 AND ${held} AND EXISTS (SELECT 1 FROM library_file WHERE id = ?5 AND status = 'checking')`,
      )
      .bind(u.id, claimToken, u.bytes, u.userId, u.fileId),
    db
      .prepare(
        `UPDATE upload SET completed_at = ?3 WHERE id = ?1 AND completing_at = ?2 AND ${OPEN}
         AND EXISTS (SELECT 1 FROM library_file WHERE id = ?4 AND status = 'checking')`,
      )
      .bind(u.id, claimToken, now, u.fileId),
  ]);
  return (closed?.meta.changes ?? 0) > 0;
}

/**
 * Abort, expiry and a failed complete: the reservation returns and the row closes, unless a fresh claim holds it.
 * `claimToken` is the caller's own claim, which may release; -1 for a caller with none. True: released.
 */
export async function releaseLibrary(
  db: BatchDb,
  u: { id: string; userId: string; bytes: number },
  now: number,
  claimToken = -1,
): Promise<boolean> {
  const free = claimFree(2, 3);
  const [, closed] = await db.batch([
    db
      .prepare(
        `UPDATE app_user SET reserved_bytes = reserved_bytes - ?4 WHERE id = ?5
         AND EXISTS (SELECT 1 FROM upload WHERE id = ?1 AND ${OPEN} AND ${free})`,
      )
      .bind(u.id, claimToken, now - CLAIM_MS, u.bytes, u.userId),
    db
      .prepare(`UPDATE upload SET aborted_at = ?4 WHERE id = ?1 AND ${OPEN} AND ${free}`)
      .bind(u.id, claimToken, now - CLAIM_MS, now),
  ]);
  return (closed?.meta.changes ?? 0) > 0;
}

/** The check passed: the file is `ready` with its digests and its validated type. True when it was `checking`. */
export async function markReady(
  db: BatchDb,
  f: { id: string; userId: string },
  r: { sha256: string; crc32: number; ext: string },
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE library_file SET status = 'ready', sha256 = ?3, crc32 = ?4, ext = ?5, updated_at = ?6
       WHERE id = ?1 AND user_id = ?2 AND status = 'checking'`,
    )
    .bind(f.id, f.userId, r.sha256, r.crc32, r.ext, now)
    .run();
  return res.meta.changes > 0;
}

/** The check refused the file: its bytes leave `used_bytes` and it is `refused`, once (guarded by `checking`). */
export async function refuseLibrary(
  db: BatchDb,
  f: { id: string; userId: string; bytes: number },
  refusal: string,
  now: number,
): Promise<boolean> {
  const checking = "EXISTS (SELECT 1 FROM library_file WHERE id = ?1 AND user_id = ?2 AND status = 'checking')";
  const [, refused] = await db.batch([
    db
      .prepare(`UPDATE app_user SET used_bytes = used_bytes - ?3 WHERE id = ?2 AND ${checking}`)
      .bind(f.id, f.userId, f.bytes),
    db
      .prepare(
        "UPDATE library_file SET status = 'refused', refusal = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2 AND status = 'checking'",
      )
      .bind(f.id, f.userId, refusal, now),
  ]);
  return (refused?.meta.changes ?? 0) > 0;
}

/** Takes the right to (re)run a `checking` file's check: false while another run touched it within the claim window. */
export async function claimCheck(db: BatchDb, f: { id: string; userId: string }, now: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE library_file SET updated_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'checking' AND updated_at < ?3 - ${CLAIM_MS}`,
    )
    .bind(f.id, f.userId, now)
    .run();
  return res.meta.changes > 0;
}

/** A library file the check left `checking`: what the sweep needs to check it again or give it up. */
export interface CheckingFile {
  id: string;
  userId: string;
  r2Key: string;
  bytes: number;
  ext: string;
  createdAt: number;
}

/** Files still `checking` that no check touched within the claim window, oldest first. */
export async function staleChecking(db: Db, now: number, limit: number): Promise<CheckingFile[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id AS userId, r2_key AS r2Key, bytes, ext, created_at AS createdAt FROM library_file
       WHERE status = 'checking' AND updated_at < ?1 - ${CLAIM_MS} ORDER BY updated_at LIMIT ?2`,
    )
    .bind(now, limit)
    .all<CheckingFile>();
  return results;
}

export interface Drift {
  userId: string;
  before: { used: number; reserved: number };
  after: { used: number; reserved: number };
}

/**
 * Recomputes both counters from the rows (the formulas of ADR 0013) and reports the drift, if any. Never blocks a
 * user. Anything else writing `used_bytes` or `reserved_bytes` is a bug this heals.
 */
export async function reconcileUser(db: BatchDb, userId: string): Promise<Drift | null> {
  const row = await db
    .prepare("SELECT used_bytes AS used, reserved_bytes AS reserved FROM app_user WHERE id = ?")
    .bind(userId)
    .first<{ used: number; reserved: number }>();
  if (!row) return null;
  await db
    .prepare(
      `UPDATE app_user SET
         used_bytes = (SELECT COALESCE(SUM(bytes), 0) FROM library_file WHERE user_id = app_user.id AND status IN ('checking', 'ready')),
         reserved_bytes = (SELECT COALESCE(SUM(bytes), 0) FROM upload WHERE user_id = app_user.id AND owner_kind = 'library' AND ${OPEN})
       WHERE id = ?`,
    )
    .bind(userId)
    .run();
  const after = await db
    .prepare("SELECT used_bytes AS used, reserved_bytes AS reserved FROM app_user WHERE id = ?")
    .bind(userId)
    .first<{ used: number; reserved: number }>();
  if (!after || (after.used === row.used && after.reserved === row.reserved)) return null;
  return { userId, before: row, after };
}

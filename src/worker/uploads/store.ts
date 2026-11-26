// Every statement on `upload` and `upload_part` (migration 0005, ADR 0013). Pure SQL over `Db`, no R2, no policy.
// Claim rule: complete's claim (`completing_at`) holds for `CLAIM_MS`; abort and the sweeps skip a younger one.
import type { Db } from "../auth/db.ts";

export const CLAIM_MS = 120_000;
/** The share of one upload's part URLs that may be minted: three per part (cost-plan W7). */
export const MINTS_PER_PART = 3;

export type Owner = { kind: "library"; userId: string } | { kind: "guest"; sessionId: string; screenRef: string };
/** The id that scopes an Idempotency-Key and ties an upload to who may touch it. */
export const ownerId = (o: Owner): string => (o.kind === "library" ? o.userId : o.sessionId);

export interface UploadRow {
  id: string;
  ownerKind: "library" | "guest";
  userId: string | null;
  screenRef: string | null;
  sessionId: string | null;
  fileId: string;
  bucket: "library" | "guest";
  r2Key: string;
  r2UploadId: string;
  name: string;
  ext: string;
  bytes: number;
  partBytes: number;
  parts: number;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  mints: number;
  idemKey: string | null;
  completingAt: number | null;
  completedAt: number | null;
  abortedAt: number | null;
}

export const COLUMNS = `id, owner_kind AS ownerKind, user_id AS userId, screen_ref AS screenRef, session_id AS sessionId,
  file_id AS fileId, bucket, r2_key AS r2Key, r2_upload_id AS r2UploadId, name, ext, bytes, part_bytes AS partBytes, parts,
  fingerprint, created_at AS createdAt, expires_at AS expiresAt, mints, idem_key AS idemKey,
  completing_at AS completingAt, completed_at AS completedAt, aborted_at AS abortedAt`;

const OPEN = "completed_at IS NULL AND aborted_at IS NULL";

/** What create writes; the counters and the close times start empty. */
export interface NewUpload {
  id: string;
  owner: Owner;
  fileId: string;
  r2Key: string;
  r2UploadId: string;
  name: string;
  ext: string;
  bytes: number;
  partBytes: number;
  parts: number;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  idemKey: string | null;
}

export const INSERT_COLUMNS = `id, owner_kind, user_id, screen_ref, session_id, file_id, bucket, r2_key, r2_upload_id, name, ext,
  bytes, part_bytes, parts, fingerprint, created_at, expires_at, idem_key`;
export const INSERT_PLACEHOLDERS = (first = 1): string =>
  Array.from({ length: 18 }, (_, i) => `?${first + i}`).join(", ");

/** The values for `INSERT_COLUMNS`, in order. */
export function insertValues(n: NewUpload): unknown[] {
  const lib = n.owner.kind === "library";
  return [
    n.id,
    n.owner.kind,
    n.owner.kind === "library" ? n.owner.userId : null,
    n.owner.kind === "guest" ? n.owner.screenRef : null,
    n.owner.kind === "guest" ? n.owner.sessionId : null,
    n.fileId,
    lib ? "library" : "guest",
    n.r2Key,
    n.r2UploadId,
    n.name,
    n.ext,
    n.bytes,
    n.partBytes,
    n.parts,
    n.fingerprint,
    n.createdAt,
    n.expiresAt,
    n.idemKey,
  ];
}

export const isOpen = (u: Pick<UploadRow, "completedAt" | "abortedAt">): boolean =>
  u.completedAt === null && u.abortedAt === null;

export const get = (db: Db, id: string): Promise<UploadRow | null> =>
  db.prepare(`SELECT ${COLUMNS} FROM upload WHERE id = ?`).bind(id).first<UploadRow>();

/** A guest's upload, by the guest session and screen; the one that ties a purge to its multipart. */
export const findOpenBySession = (db: Db, sessionId: string): Promise<UploadRow | null> =>
  db
    .prepare(`SELECT ${COLUMNS} FROM upload WHERE session_id = ? AND ${OPEN} ORDER BY created_at DESC LIMIT 1`)
    .bind(sessionId)
    .first<UploadRow>();

/** The owner's open, unexpired upload of this file (the resume key), or null. */
export const findOpen = (db: Db, owner: Owner, fingerprint: string, now: number): Promise<UploadRow | null> =>
  db
    .prepare(
      `SELECT ${COLUMNS} FROM upload WHERE ${owner.kind === "library" ? "user_id" : "session_id"} = ? AND fingerprint = ?
       AND ${OPEN} AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(ownerId(owner), fingerprint, now)
    .first<UploadRow>();

/** The row an Idempotency-Key created for this owner, within the window, or null. */
export const findByIdem = (db: Db, id: string, keyHash: string, since: number): Promise<UploadRow | null> =>
  db
    .prepare(
      `SELECT ${COLUMNS} FROM upload WHERE COALESCE(user_id, session_id) = ? AND idem_key = ? AND created_at >= ?`,
    )
    .bind(id, keyHash, since)
    .first<UploadRow>();

export interface OpenListing {
  id: string;
  name: string;
  bytes: number;
  parts: number;
  done: number;
  createdAt: number;
}

/** A user's open, unexpired library uploads, newest first, at most `limit`. */
export async function listOpen(db: Db, userId: string, now: number, limit = 20): Promise<OpenListing[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, bytes, parts, created_at AS createdAt,
         (SELECT count(*) FROM upload_part p WHERE p.upload_id = upload.id) AS done
       FROM upload WHERE user_id = ? AND ${OPEN} AND expires_at > ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, now, limit)
    .all<OpenListing>();
  return results;
}

export interface DonePart {
  n: number;
  etag: string;
  bytes: number;
}

export async function doneParts(db: Db, id: string): Promise<DonePart[]> {
  const { results } = await db
    .prepare("SELECT n, etag, bytes FROM upload_part WHERE upload_id = ? ORDER BY n")
    .bind(id)
    .all<DonePart>();
  return results;
}

/**
 * Records one part of an open upload; a repeat of the same part replaces it (R2 does the same). Zero changes: the
 * upload is closed or unknown.
 */
export async function recordPart(
  db: Db,
  id: string,
  n: number,
  etag: string,
  bytes: number,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO upload_part (upload_id, n, etag, bytes, at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM upload WHERE id = ?1 AND ${OPEN})
       ON CONFLICT (upload_id, n) DO UPDATE SET etag = excluded.etag, bytes = excluded.bytes, at = excluded.at`,
    )
    .bind(id, n, etag, bytes, now)
    .run();
  return res.meta.changes > 0;
}

/** Adds `k` minted URLs to an open upload's count if that keeps it within three per part. False: over budget. */
export async function chargeMints(db: Db, id: string, k: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE upload SET mints = mints + ?2 WHERE id = ?1 AND ${OPEN} AND mints + ?2 <= parts * ${MINTS_PER_PART}`,
    )
    .bind(id, k)
    .run();
  return res.meta.changes > 0;
}

/** Complete's claim, held for `CLAIM_MS`. True: this caller owns the row; its `now` is the claim token. */
export async function claim(db: Db, id: string, now: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE upload SET completing_at = ?2 WHERE id = ?1 AND ${OPEN} AND (completing_at IS NULL OR completing_at < ?2 - ${CLAIM_MS})`,
    )
    .bind(id, now)
    .run();
  return res.meta.changes > 0;
}

/** Open uploads whose complete began and never finished: the claim has gone stale. */
export async function staleCompletes(db: Db, now: number, limit: number): Promise<UploadRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM upload WHERE completing_at IS NOT NULL AND completing_at < ? - ${CLAIM_MS} AND ${OPEN} LIMIT ?`,
    )
    .bind(now, limit)
    .all<UploadRow>();
  return results;
}

/** Open uploads past their expiry that no fresh claim protects. */
export async function expiredOpen(db: Db, now: number, limit: number): Promise<UploadRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM upload WHERE ${OPEN} AND expires_at < ?1 AND completing_at IS NULL LIMIT ?2`)
    .bind(now, limit)
    .all<UploadRow>();
  return results;
}

/** Deletes closed uploads that closed before `before`, with their parts; returns how many. */
export async function deleteClosed(db: Db, before: number, limit: number): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM upload WHERE id IN (SELECT id FROM upload
         WHERE (completed_at IS NOT NULL OR aborted_at IS NOT NULL) AND COALESCE(completed_at, aborted_at) < ? LIMIT ?)`,
    )
    .bind(before, limit)
    .run();
  return res.meta.changes;
}

/** A guest upload: one open row per session, so a double tap cannot open two. Zero changes: one is already open. */
export async function insertGuest(db: Db, n: NewUpload): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO upload (${INSERT_COLUMNS}) SELECT ${INSERT_PLACEHOLDERS()}
       WHERE NOT EXISTS (SELECT 1 FROM upload WHERE session_id = ?19 AND ${OPEN})`,
    )
    .bind(...insertValues(n), n.owner.kind === "guest" ? n.owner.sessionId : "")
    .run();
  return res.meta.changes > 0;
}

/** SQL true of a row nobody holds: no claim, the caller's own, or one gone stale. Takes the numbers of two bound parameters. */
export const claimFree = (claimParam: number, staleParam: number): string =>
  `(completing_at IS NULL OR completing_at = ?${claimParam} OR completing_at < ?${staleParam})`;

/** A guest upload has no quota to settle: it closes as aborted by abort, or the sweep, or after its object is deleted. */
export async function closeGuest(db: Db, id: string, now: number, claimToken = -1): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE upload SET aborted_at = ?1 WHERE id = ?2 AND owner_kind = 'guest' AND ${OPEN} AND ${claimFree(3, 4)}`,
    )
    .bind(now, id, claimToken, now - CLAIM_MS)
    .run();
  return res.meta.changes > 0;
}

/** A guest upload's complete finished: the row closes under the claim that did it. */
export async function completeGuest(db: Db, id: string, claimToken: number, now: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE upload SET completed_at = ?1 WHERE id = ?2 AND completing_at = ?3 AND ${OPEN}`)
    .bind(now, id, claimToken)
    .run();
  return res.meta.changes > 0;
}

// Every write to the `derived` table (one row per version, the truth every page reads). Each write is one statement
// guarded by (file_id, version, run_id) and the prior status, so a stale writer changes nothing and is told so.
import { z } from "zod";
import type { Db } from "../auth/db.ts";
import { MAX_ATTEMPTS, RETRYABLE } from "./codes.ts";
import { GUEST_SERVABLE, LIBRARY_FROM, LIBRARY_SERVABLE, type OwnerKind } from "./keys.ts";

/** `ready720`: a video's 720p mp4 is stored and playable; the full encode is still running (the row has a stage) or has
 * ended without one (no stage), in which case the 720p is the final output. */
export const DERIVED_STATUS = ["queued", "running", "ready720", "done", "failed", "skipped", "cancelled"] as const;
export type DerivedStatus = (typeof DERIVED_STATUS)[number];

/** Readers ask this and never compare the status themselves: true when the row has something to play. */
export const isPlayable = (status: string | null | undefined): boolean => status === "done" || status === "ready720";

/** The stored name a player reads: the full encode when it is stored, else the 720p. Null when neither is. */
export function playableKey(row: { status: string; outputs: string | null }): "m/0.mp4" | "m/720.mp4" | null {
  if (!isPlayable(row.status) || row.outputs === null) return null;
  const parsed = outputsSchema.safeParse(safeJson(row.outputs));
  if (!parsed.success || !parsed.data.groups.media) return null;
  const names = new Set(parsed.data.files.map((f) => f.path));
  return names.has("m/0.mp4") ? "m/0.mp4" : names.has("m/720.mp4") ? "m/720.mp4" : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A row whose run is still going: queued, running, or a ready720 whose full encode has not ended (it keeps a stage). */
const liveWhere = (col = ""): string =>
  `(${col}status IN ('queued', 'running') OR (${col}status = 'ready720' AND ${col}stage IS NOT NULL))`;

export interface RunKey {
  fileId: string;
  version: number;
  runId: string;
}

const int = z.number().int().nonnegative();

/** `derived.outputs`: what was stored and which groups passed. `files` holds the stored relative names. */
export const outputsSchema = z.strictObject({
  v: z.literal(1),
  groups: z.strictObject({
    slides: z.boolean(),
    pdf: z.boolean(),
    notes: z.boolean(),
    media: z.boolean(),
    image: z.boolean(),
  }),
  total: int,
  rendered: int,
  files: z
    .array(z.strictObject({ path: z.string().max(64), size: int, sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .max(20),
  packs: z.record(z.string(), z.strictObject({ size: int })),
  originalSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type Outputs = z.infer<typeof outputsSchema>;

export const derivedRowSchema = z.object({
  file_id: z.string(),
  version: int,
  owner_kind: z.string(),
  status: z.enum(DERIVED_STATUS),
  stage: z.string().nullable(),
  pages: int.nullable(),
  has_notes: int.nullable(),
  has_motion: int.nullable(),
  fonts_missing: z.string().nullable(),
  outputs: z.string().nullable(),
  bytes: int.nullable(),
  error: z.string().nullable(),
  attempts: int,
  run_id: z.string().nullable(),
  created_at: int,
  updated_at: int,
});
export type DerivedRow = z.infer<typeof derivedRowSchema>;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * The one claim: a new run id on a version that is skipped, cancelled or failed retryably with starts to spare. One
 * statement, so concurrent callers have one winner; false means a run is live, done, or out of attempts.
 */
export async function claimRun(
  db: Db,
  a: { fileId: string; version: number; ownerKind: OwnerKind; runId: string; now: number },
): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO derived (file_id, version, owner_kind, status, stage, attempts, run_id, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', NULL, 0, ?, ?, ?)
       ON CONFLICT (file_id, version) DO UPDATE SET status = 'queued', stage = NULL, error = NULL, run_id = excluded.run_id, updated_at = excluded.updated_at
       WHERE derived.status IN ('skipped', 'cancelled')
          OR (derived.status = 'failed' AND derived.error IN (${placeholders(RETRYABLE.length)}) AND derived.attempts < ?)`,
    )
    .bind(a.fileId, a.version, a.ownerKind, a.runId, a.now, a.now, ...RETRYABLE, MAX_ATTEMPTS)
    .run();
  return r.meta.changes === 1;
}

const GUARD = `file_id = ? AND version = ? AND run_id = ?`;

/** `waiting` keeps the row queued (no container yet); every other stage is running. Counts as a heartbeat. */
export async function setStage(db: Db, k: RunKey, stage: string, now: number): Promise<boolean> {
  const status = stage === "waiting" ? "queued" : "running";
  const r = await db
    .prepare(
      // A ready720 row stays playable while its full encode reports stages.
      `UPDATE derived SET status = CASE WHEN status = 'ready720' THEN status ELSE ? END, stage = ?, updated_at = ? WHERE ${GUARD} AND ${liveWhere()}`,
    )
    .bind(status, stage, now, k.fileId, k.version, k.runId)
    .run();
  return r.meta.changes === 1;
}

/** One per container start: `attempts` never resets across runs, so a version never starts more than MAX_ATTEMPTS. */
export async function startAttempt(db: Db, k: RunKey, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE derived SET attempts = attempts + 1, status = 'running', stage = 'starting', updated_at = ? WHERE ${GUARD} AND ${liveWhere()} AND attempts < ?`,
    )
    .bind(now, k.fileId, k.version, k.runId, MAX_ATTEMPTS)
    .run();
  return r.meta.changes === 1;
}

export async function heartbeat(db: Db, k: RunKey, now: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE derived SET updated_at = ? WHERE ${GUARD} AND ${liveWhere()}`)
    .bind(now, k.fileId, k.version, k.runId)
    .run();
  return r.meta.changes === 1;
}

export interface DonePayload {
  pages: number | null;
  hasNotes: boolean;
  hasMotion: boolean;
  fontsMissing: readonly string[];
  outputs: Outputs;
  bytes: number;
}

/**
 * Publishes the outputs, only while the run is live and the file is still servable (the same fragments as `locate`).
 * `done` is the end. `ready720` with a stage is the early 720p publish while the full encode runs; `ready720` with no
 * stage is the 720p as the final output.
 */
export async function publishDone(
  db: Db,
  k: RunKey,
  p: DonePayload,
  now: number,
  as: { status: "done" | "ready720"; stage: string | null } = { status: "done", stage: null },
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE derived SET status = ?, stage = ?, error = NULL, pages = ?, has_notes = ?, has_motion = ?, fonts_missing = ?, outputs = ?, bytes = ?, updated_at = ?
       WHERE ${GUARD} AND (status = 'running' OR (status = 'ready720' AND stage IS NOT NULL)) AND (
         (owner_kind = 'library' AND EXISTS (SELECT 1 FROM ${LIBRARY_FROM} WHERE f.id = derived.file_id AND f.version = derived.version AND ${LIBRARY_SERVABLE}))
         OR (owner_kind = 'guest' AND EXISTS (SELECT 1 FROM guest_file g WHERE g.session_id = derived.file_id AND ${GUEST_SERVABLE})))`,
    )
    .bind(
      as.status,
      as.stage,
      p.pages,
      p.hasNotes ? 1 : 0,
      p.hasMotion ? 1 : 0,
      JSON.stringify(p.fontsMissing),
      JSON.stringify(p.outputs),
      p.bytes,
      now,
      k.fileId,
      k.version,
      k.runId,
    )
    .run();
  return r.meta.changes === 1;
}

/** The full encode ended without output: the 720p already published is the final one. Only a live ready720 row moves. */
export async function settlePreview(db: Db, k: RunKey, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE derived SET stage = NULL, updated_at = ? WHERE ${GUARD} AND status = 'ready720' AND stage IS NOT NULL`,
    )
    .bind(now, k.fileId, k.version, k.runId)
    .run();
  return r.meta.changes === 1;
}

export async function markFailed(db: Db, k: RunKey, code: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE derived SET status = 'failed', stage = NULL, error = ?, updated_at = ? WHERE ${GUARD} AND ${liveWhere()}`,
    )
    .bind(code, now, k.fileId, k.version, k.runId)
    .run();
  return r.meta.changes === 1;
}

/** No container ran. */
export async function markSkipped(db: Db, k: RunKey, code: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE derived SET status = 'skipped', stage = NULL, error = ?, updated_at = ? WHERE ${GUARD} AND ${liveWhere()}`,
    )
    .bind(code, now, k.fileId, k.version, k.runId)
    .run();
  return r.meta.changes === 1;
}

/**
 * Ends the run that is live on this version and returns its id (null when none is), for `converter.cancel`. With
 * `onlyRun` it ends that run alone: a stale Converter must not cancel the run that replaced it.
 */
export async function markCancelled(
  db: Db,
  fileId: string,
  version: number,
  now: number,
  onlyRun: string | null = null,
): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE derived SET status = 'cancelled', stage = NULL, updated_at = ? WHERE file_id = ? AND version = ? AND ${liveWhere()} AND (? IS NULL OR run_id = ?) RETURNING run_id`,
    )
    .bind(now, fileId, version, onlyRun, onlyRun)
    .first<{ run_id: string | null }>();
  return row?.run_id ?? null;
}

export async function readRun(db: Db, fileId: string, version: number): Promise<DerivedRow | null> {
  const row = await db.prepare("SELECT * FROM derived WHERE file_id = ? AND version = ?").bind(fileId, version).first();
  return row ? derivedRowSchema.parse(row) : null;
}

/** Live rows nobody has touched since `before`: the sweep asks each one's Converter what is going on. */
export async function staleRuns(
  db: Db,
  before: number,
  limit = 50,
): Promise<{ fileId: string; version: number; runId: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT file_id, version, run_id FROM derived WHERE ${liveWhere()} AND ? > updated_at AND run_id IS NOT NULL ORDER BY updated_at LIMIT ?`,
    )
    .bind(before, limit)
    .all<{ file_id: string; version: number; run_id: string }>();
  return results.map((r) => ({ fileId: r.file_id, version: r.version, runId: r.run_id }));
}

/** Queued plus running rows, overall, for one user's files, and for guest and demo files: the queue caps read these. */
export async function queueDepth(db: Db, userId: string | null): Promise<{ all: number; user: number; guest: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM derived WHERE ${liveWhere()}) AS n_all,
         (SELECT count(*) FROM derived WHERE ${liveWhere()} AND owner_kind = 'guest') AS n_guest,
         (SELECT count(*) FROM derived d JOIN library_file f ON f.id = d.file_id WHERE ${liveWhere("d.")} AND d.owner_kind = 'library' AND f.user_id = ?) AS n_user`,
    )
    .bind(userId ?? "")
    .first<{ n_all: number; n_guest: number; n_user: number }>();
  return { all: row?.n_all ?? 0, user: row?.n_user ?? 0, guest: row?.n_guest ?? 0 };
}

// Every library_file read and write the library routes, the library FileSource and the export make (ADR 0016). Each
// statement names the owner in its WHERE (LIB-01) and every write is one guarded UPDATE: none inserts, so no order of
// rename, trash, restore and purge can resurrect a row or leave a ghost (LIB-12). Bytes move only through U's quota
// builders, never here.
import type { Db, Statement } from "../auth/db.ts";
import { renamed } from "./names.ts";

/** D1's atomic batch, which the plain `Db` slice leaves out. */
export interface LibDb extends Db {
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}
export const libDbOf = (binding: unknown): LibDb => binding as LibDb;

export const UP_NEXT_MAX = 12;
export const PAGE_SIZE = 200;
/** A restore closes this long before a file is due, so clock skew cannot bring back a row whose bytes are going. */
export const RESTORE_MARGIN_MS = 300_000;
/** D1 binds at most 100 parameters a statement; an id list stays under it with room for the fixed ones. */
const IDS_PER_STATEMENT = 90;

const marks = (from: number, n: number): string => Array.from({ length: n }, (_, i) => `?${from + i}`).join(", ");
const chunks = <T>(list: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(list.length / IDS_PER_STATEMENT) }, (_, i) =>
    list.slice(i * IDS_PER_STATEMENT, (i + 1) * IDS_PER_STATEMENT),
  );

/**
 * The serving predicate, written once (ADR 0015): ?1 is the owner; the aliases are f for the file row and u for the owner.
 * V2's publish reuses it, so what a presenter may fetch and what a conversion may publish never drift (LIB-14).
 */
export const SERVABLE_FROM = "library_file f JOIN app_user u ON u.id = f.user_id";
export const SERVABLE_SQL =
  "f.user_id = ?1 AND f.status = 'ready' AND f.trashed_at IS NULL AND f.disabled_at IS NULL AND u.status = 'active' AND u.suspended_at IS NULL";
/** A fetch on behalf of a screen also needs the pairing's session to be alive: ?2 is its public id, ?3 the time. */
export const PINNED_SQL =
  "EXISTS (SELECT 1 FROM phone_session s WHERE s.public_id = ?2 AND s.user_id = f.user_id AND s.expires_at > ?3)";

/** `null` leaves the session out: only a `/p/` fetch, which carries no session and whose token lives 300 s. */
export interface Pinned {
  publicId: string;
  now: number;
}

export interface Ref {
  id: string;
  version: number;
}

export interface Servable {
  id: string;
  version: number;
  name: string;
  ext: string;
  bytes: number;
  r2Key: string;
  sha256: string | null;
  crc32: number | null;
}

interface ServableRow {
  id: string;
  version: number;
  name: string;
  ext: string;
  bytes: number;
  r2_key: string;
  sha256: string | null;
  crc32: number | null;
}

const SERVABLE_COLUMNS = "f.id, f.version, f.name, f.ext, f.bytes, f.r2_key, f.sha256, f.crc32";
const servableOf = (r: ServableRow): Servable => ({
  id: r.id,
  version: r.version,
  name: r.name,
  ext: r.ext,
  bytes: r.bytes,
  r2Key: r.r2_key,
  sha256: r.sha256,
  crc32: r.crc32,
});

const pinnedSql = (pinned: Pinned | null) => (pinned ? ` AND ${PINNED_SQL}` : "");
const pinnedBinds = (pinned: Pinned | null): unknown[] => (pinned ? [pinned.publicId, pinned.now] : []);

/** The refs that are servable right now, by id, in one query per 90. A ref naming another version is not servable. */
export async function servable(
  db: Db,
  userId: string,
  refs: readonly Ref[],
  pinned: Pinned | null,
): Promise<Map<string, Servable>> {
  const found = new Map<string, Servable>();
  const first = pinned ? 4 : 2;
  for (const part of chunks(refs)) {
    const { results } = await db
      .prepare(
        `SELECT ${SERVABLE_COLUMNS} FROM ${SERVABLE_FROM} WHERE ${SERVABLE_SQL}${pinnedSql(pinned)}
         AND f.id IN (${marks(first, part.length)})`,
      )
      .bind(userId, ...pinnedBinds(pinned), ...part.map((r) => r.id))
      .all<ServableRow>();
    const wanted = new Map(part.map((r) => [r.id, r.version]));
    for (const row of results) if (wanted.get(row.id) === row.version) found.set(row.id, servableOf(row));
  }
  return found;
}

/** What the library source lists: Up Next first in its order, then the newest, at most `limit`. */
export async function servableRecent(
  db: Db,
  userId: string,
  pinned: Pinned | null,
  limit: number,
): Promise<Servable[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SERVABLE_COLUMNS} FROM ${SERVABLE_FROM} WHERE ${SERVABLE_SQL}${pinnedSql(pinned)}
       ORDER BY f.selected_at IS NULL, f.selected_at, f.updated_at DESC, f.id LIMIT ?${pinned ? 4 : 2}`,
    )
    .bind(userId, ...pinnedBinds(pinned), limit)
    .all<ServableRow>();
  return results.map(servableOf);
}

export type View = "files" | "trash";
export type Sort = "updated" | "name" | "size";

export interface DerivedState {
  state: "none" | "preparing" | "ready" | "failed";
  stage: string | null;
  pages: number | null;
  fontsMissing: string[];
}

export interface FileRow {
  id: string;
  version: number;
  name: string;
  ext: string;
  bytes: number;
  status: string;
  refusal: string | null;
  updatedAt: number;
  lastPresentedAt: number | null;
  selected: boolean;
  trashedAt: number | null;
  purgeAfter: number | null;
  disabled: boolean;
  derived: DerivedState;
}

interface DbFile {
  id: string;
  version: number;
  name: string;
  ext: string;
  bytes: number;
  status: string;
  refusal: string | null;
  updated_at: number;
  last_presented_at: number | null;
  selected_at: number | null;
  trashed_at: number | null;
  purge_after: number | null;
  disabled_at: number | null;
  d_status: string | null;
  d_stage: string | null;
  d_pages: number | null;
  d_fonts: string | null;
}

const ROW_SQL = `SELECT f.id, f.version, f.name, f.ext, f.bytes, f.status, f.refusal, f.updated_at, f.last_presented_at,
  f.selected_at, f.trashed_at, f.purge_after, f.disabled_at,
  d.status AS d_status, d.stage AS d_stage, d.pages AS d_pages, d.fonts_missing AS d_fonts
  FROM library_file f LEFT JOIN derived d ON d.file_id = f.id AND d.version = f.version
  WHERE f.user_id = ?1 AND f.status != 'purged'`;

const DERIVED_STATE: Record<string, DerivedState["state"]> = {
  queued: "preparing",
  running: "preparing",
  done: "ready",
  failed: "failed",
};

function fontsOf(text: string | null): string[] {
  try {
    const parsed: unknown = text === null ? [] : JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

const rowOf = (r: DbFile): FileRow => ({
  id: r.id,
  version: r.version,
  name: r.name,
  ext: r.ext,
  bytes: r.bytes,
  status: r.status,
  refusal: r.refusal,
  updatedAt: r.updated_at,
  lastPresentedAt: r.last_presented_at,
  selected: r.selected_at !== null && r.trashed_at === null,
  trashedAt: r.trashed_at,
  purgeAfter: r.purge_after,
  disabled: r.disabled_at !== null,
  derived: {
    state: DERIVED_STATE[r.d_status ?? ""] ?? "none",
    stage: r.d_stage,
    pages: r.d_pages,
    fontsMissing: fontsOf(r.d_fonts),
  },
});

/** One file of this owner that has not been purged, trashed or not; null for an unknown or foreign id (LIB-01). */
export async function fileRow(db: Db, userId: string, id: string): Promise<FileRow | null> {
  const row = await db.prepare(`${ROW_SQL} AND f.id = ?2`).bind(userId, id).first<DbFile>();
  return row ? rowOf(row) : null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The sort a view uses. Trash is by due time, soonest first; `updated` is newest first, `size` largest first. */
const orders: Record<Sort, (a: FileRow, b: FileRow) => number> = {
  updated: (a, b) => b.updatedAt - a.updatedAt || byId(b.id, a.id),
  name: (a, b) => collator.compare(a.name, b.name) || byId(a.id, b.id),
  size: (a, b) => b.bytes - a.bytes || byId(a.id, b.id),
};
const trashOrder = (a: FileRow, b: FileRow): number => (a.purgeAfter ?? 0) - (b.purgeAfter ?? 0) || byId(a.id, b.id);

/** A cursor is the last row's sort values: it still works after that row is deleted. */
interface Cursor {
  id: string;
  updatedAt: number;
  name: string;
  bytes: number;
  purgeAfter: number;
}
const cursorOf = (r: FileRow): string =>
  btoa(
    JSON.stringify({ id: r.id, updatedAt: r.updatedAt, name: r.name, bytes: r.bytes, purgeAfter: r.purgeAfter ?? 0 }),
  );

function readCursor(text: string): Cursor | null {
  try {
    const c = JSON.parse(atob(text)) as Partial<Cursor>;
    const ok =
      typeof c.id === "string" &&
      typeof c.name === "string" &&
      [c.updatedAt, c.bytes, c.purgeAfter].every((n) => Number.isSafeInteger(n));
    return ok ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

/** A cursor's row stands in for the real one in the comparator: only the fields that order the view are read. */
const asRow = (c: Cursor): FileRow =>
  ({ id: c.id, updatedAt: c.updatedAt, name: c.name, bytes: c.bytes, purgeAfter: c.purgeAfter }) as FileRow;

export type Page = { ok: true; files: FileRow[]; next: string | null } | { ok: false };

/**
 * One page of the files view or the trash view. The rows come from one indexed read of the owner's prefix, which
 * LIBRARY_MAX_FILES bounds, so every sort is in memory and the cursor is keyset over (sort key, id). `ok: false` is a
 * cursor that is not ours.
 */
export async function listFiles(db: Db, userId: string, view: View, sort: Sort, cursor: string | null): Promise<Page> {
  const after = cursor === null ? null : readCursor(cursor);
  if (cursor !== null && !after) return { ok: false };
  const { results } = await db
    .prepare(`${ROW_SQL} AND f.trashed_at IS ${view === "trash" ? "NOT " : ""}NULL`)
    .bind(userId)
    .all<DbFile>();
  const order = view === "trash" ? trashOrder : orders[sort];
  const sorted = results.map(rowOf).sort(order);
  const rest = after ? sorted.filter((r) => order(r, asRow(after)) > 0) : sorted;
  const files = rest.slice(0, PAGE_SIZE);
  const last = files.at(-1);
  return { ok: true, files, next: rest.length > PAGE_SIZE && last ? cursorOf(last) : null };
}

/** Up Next as ids, in tick order, trashed rows left out. */
export const SELECTED_SQL = "user_id = ?1 AND selected_at IS NOT NULL AND trashed_at IS NULL AND status != 'purged'";
const SELECTED_COUNT = `(SELECT count(*) FROM library_file WHERE ${SELECTED_SQL})`;

export async function upNext(db: Db, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM library_file WHERE ${SELECTED_SQL} ORDER BY selected_at, id`)
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export interface Overview {
  quota: { used: number; reserved: number; limit: number };
  trash: { count: number; bytes: number };
}

export async function overview(db: Db, userId: string, defaultQuota: number): Promise<Overview> {
  const user = await db
    .prepare("SELECT used_bytes, reserved_bytes, quota_bytes FROM app_user WHERE id = ?1")
    .bind(userId)
    .first<{ used_bytes: number; reserved_bytes: number; quota_bytes: number | null }>();
  const trash = await db
    .prepare(
      `SELECT count(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM library_file
       WHERE user_id = ?1 AND trashed_at IS NOT NULL AND status != 'purged'`,
    )
    .bind(userId)
    .first<{ n: number; b: number }>();
  return {
    quota: {
      used: user?.used_bytes ?? 0,
      reserved: user?.reserved_bytes ?? 0,
      limit: user?.quota_bytes ?? defaultQuota,
    },
    trash: { count: trash?.n ?? 0, bytes: trash?.b ?? 0 },
  };
}

export interface OpenUpload {
  uploadId: string;
  fileId: string;
  name: string;
  bytes: number;
  createdAt: number;
}

/** The uploads still open, so a reloaded page shows a row for each (U's `saved` refetches the file's own row). */
export async function openUploads(db: Db, userId: string, now: number): Promise<OpenUpload[]> {
  const { results } = await db
    .prepare(
      `SELECT id, file_id, name, bytes, created_at FROM upload
       WHERE user_id = ?1 AND owner_kind = 'library' AND completed_at IS NULL AND aborted_at IS NULL AND expires_at > ?2
       ORDER BY created_at, id`,
    )
    .bind(userId, now)
    .all<{ id: string; file_id: string; name: string; bytes: number; created_at: number }>();
  return results.map((r) => ({
    uploadId: r.id,
    fileId: r.file_id,
    name: r.name,
    bytes: r.bytes,
    createdAt: r.created_at,
  }));
}

export type Change = "ok" | "not_found" | "bad_request" | "up_next_full";

const OWNED = "user_id = ?1 AND id = ?2 AND status != 'purged'";

/** The base name replaces the stem and the extension stays; a rename is not a content change, so `updated_at` stays. */
export async function rename(db: Db, userId: string, id: string, base: string): Promise<Change> {
  const row = await db
    .prepare(`SELECT ext FROM library_file WHERE ${OWNED} AND trashed_at IS NULL`)
    .bind(userId, id)
    .first<{ ext: string }>();
  if (!row) return "not_found";
  const name = renamed(base, row.ext);
  if (name === null) return "bad_request";
  const done = await db
    .prepare(`UPDATE library_file SET name = ?3 WHERE ${OWNED} AND trashed_at IS NULL AND ext = ?4`)
    .bind(userId, id, name, row.ext)
    .run();
  return done.meta.changes === 1 ? "ok" : "not_found";
}

/** Absolute state: ticking a ticked row, or unticking an unticked one, is a success that changes nothing. */
export async function setSelected(db: Db, userId: string, id: string, selected: boolean): Promise<Change> {
  const row = await db
    .prepare(`SELECT selected_at FROM library_file WHERE ${OWNED} AND trashed_at IS NULL`)
    .bind(userId, id)
    .first<{ selected_at: number | null }>();
  if (!row) return "not_found";
  if (!selected) {
    await db
      .prepare(`UPDATE library_file SET selected_at = NULL WHERE ${OWNED} AND trashed_at IS NULL`)
      .bind(userId, id)
      .run();
    return "ok";
  }
  if (row.selected_at !== null) return "ok";
  const done = await db
    .prepare(
      `UPDATE library_file SET selected_at = ?3
       WHERE ${OWNED} AND trashed_at IS NULL AND status = 'ready' AND disabled_at IS NULL AND selected_at IS NULL
         AND ${SELECTED_COUNT} < ${UP_NEXT_MAX}`,
    )
    .bind(userId, id, Date.now())
    .run();
  if (done.meta.changes === 1) return "ok";
  const again = await fileRow(db, userId, id);
  return again?.selected ? "ok" : again && again.status === "ready" && !again.disabled ? "up_next_full" : "not_found";
}

/**
 * The whole of Up Next in one batch: rows not named lose their tick, each named row gets `now + position`, guarded as
 * a tick is. Returns the order that resulted, which is what the caller shows.
 */
export async function setUpNext(db: LibDb, userId: string, ids: readonly string[], now: number): Promise<string[]> {
  const kept = [...new Set(ids)].slice(0, UP_NEXT_MAX);
  const clear = db
    .prepare(
      `UPDATE library_file SET selected_at = NULL
       WHERE user_id = ?1 AND selected_at IS NOT NULL AND trashed_at IS NULL AND id NOT IN (${marks(2, kept.length || 1)})`,
    )
    .bind(userId, ...(kept.length ? kept : [""]));
  const set = kept.map((id, i) =>
    db
      .prepare(
        `UPDATE library_file SET selected_at = ?3
         WHERE ${OWNED} AND trashed_at IS NULL AND status = 'ready' AND disabled_at IS NULL
           AND (selected_at IS NOT NULL OR ${SELECTED_COUNT} < ${UP_NEXT_MAX})`,
      )
      .bind(userId, id, now + i),
  );
  await db.batch([clear, ...set]);
  return upNext(db, userId);
}

/** P1's approve batch: the files a screen was just given are the last presented. Only this owner's rows can change. */
export function markPresented(db: Db, userId: string, ids: readonly string[], now: number): Statement {
  return db
    .prepare(`UPDATE library_file SET last_presented_at = ?2 WHERE user_id = ?1 AND id IN (${marks(3, ids.length)})`)
    .bind(userId, now, ...ids);
}

/** Into the trash, due `trashDays` on. The tick stays, so a restore puts the file back in its Up Next place. */
export async function trash(db: Db, userId: string, id: string, now: number, trashDays: number): Promise<Change> {
  const done = await db
    .prepare(`UPDATE library_file SET trashed_at = ?3, purge_after = ?4 WHERE ${OWNED} AND trashed_at IS NULL`)
    .bind(userId, id, now, now + trashDays * 86_400_000)
    .run();
  return done.meta.changes === 1 ? "ok" : "not_found";
}

/**
 * Back from the trash while it is more than the margin from due. A file whose tick would be the 13th loses the tick in
 * the same statement. The purge takes `purge_after <= now`, so the two sets never meet.
 */
export async function restore(db: Db, userId: string, id: string, now: number): Promise<Change> {
  const done = await db
    .prepare(
      `UPDATE library_file SET trashed_at = NULL, purge_after = NULL,
         selected_at = CASE WHEN selected_at IS NOT NULL AND ${SELECTED_COUNT} >= ${UP_NEXT_MAX} THEN NULL ELSE selected_at END
       WHERE ${OWNED} AND trashed_at IS NOT NULL AND purge_after > ?3`,
    )
    .bind(userId, id, now + RESTORE_MARGIN_MS)
    .run();
  return done.meta.changes === 1 ? "ok" : "not_found";
}

/**
 * Delete Now and Empty Trash: the trashed rows named (or all of them) become due at once, which closes restore, and
 * the purge alarm does the rest. Returns how many became due.
 */
export async function makeDue(db: Db, userId: string, ids: readonly string[] | "all", now: number): Promise<number> {
  const due = "user_id = ?1 AND trashed_at IS NOT NULL AND status != 'purged' AND purge_after > ?2";
  if (ids === "all") {
    return (
      await db
        .prepare(`UPDATE library_file SET purge_after = ?2 WHERE ${due}`)
        .bind(userId, now - 1)
        .run()
    ).meta.changes;
  }
  let n = 0;
  for (const part of chunks(ids)) {
    n += (
      await db
        .prepare(`UPDATE library_file SET purge_after = ?2 WHERE ${due} AND id IN (${marks(3, part.length)})`)
        .bind(userId, now - 1, ...part)
        .run()
    ).meta.changes;
  }
  return n;
}

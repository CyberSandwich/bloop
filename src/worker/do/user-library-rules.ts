// The UserLibrary object's row logic over `ctx.storage.sql`: progress with its throttle, the live-screen rows, the
// leases and the stored idempotency answers. Plain functions over a SqlLike and a clock, so a test moves time.
import type { SqlLike } from "./demo-slots.ts";

const DAY_MS = 86_400_000;
/** A file's progress frame goes out at most this often (1.11). */
export const PROGRESS_FRAME_MS = 1000;
export const MAX_SCREEN_ROWS = 20;
export const EXPORT_LEASE = "export";
/** Short, and renewed while bytes flow: a client that vanished mid-download is not always noticed, so the lease must lapse by itself. */
export const EXPORT_LEASE_MS = 900_000;

export interface Progress {
  id: string;
  version: number;
  stage: string;
  done: number;
  total: number;
}

export interface ScreenRow {
  sessionId: string;
  screenRef: string;
  bySession: string;
  label: string;
  fileIds: string[];
  startedAt: number;
  endsAt: number | null;
}

/**
 * Stores a progress step. True when a frame should go out: the first for this file and stage, or a second since the
 * last frame. `updated_at` is the time of the last frame, so a throttled step changes the counts and nothing else.
 */
export function recordProgress(sql: SqlLike, p: Progress, now: number): boolean {
  const prev = sql
    .exec("SELECT stage, updated_at FROM progress WHERE file_id = ? AND version = ?", p.id, p.version)
    .toArray()[0] as { stage: string; updated_at: number } | undefined;
  const frame = !prev || prev.stage !== p.stage || now - prev.updated_at >= PROGRESS_FRAME_MS;
  if (!prev) {
    sql.exec("INSERT INTO progress VALUES (?, ?, ?, ?, ?, ?)", p.id, p.version, p.stage, p.done, p.total, now);
  } else {
    sql.exec(
      "UPDATE progress SET stage = ?, done = ?, total = ?, updated_at = ? WHERE file_id = ? AND version = ?",
      p.stage,
      p.done,
      p.total,
      frame ? now : prev.updated_at,
      p.id,
      p.version,
    );
  }
  return frame;
}

export const clearProgress = (sql: SqlLike, id: string, version: number): void => {
  sql.exec("DELETE FROM progress WHERE file_id = ? AND version = ?", id, version);
};

export function allProgress(sql: SqlLike): Progress[] {
  return sql
    .exec("SELECT file_id, version, stage, done, total FROM progress ORDER BY updated_at")
    .toArray()
    .map((r) => ({
      id: r.file_id as string,
      version: r.version as number,
      stage: r.stage as string,
      done: r.done as number,
      total: r.total as number,
    }));
}

/** A screen row goes in. Past 20 rows the oldest ended ones go; a live row is never dropped, or it could not be ended. */
export function putScreen(sql: SqlLike, row: ScreenRow): void {
  sql.exec(
    "INSERT OR REPLACE INTO screen VALUES (?, ?, ?, ?, ?, ?, NULL)",
    row.sessionId,
    row.screenRef,
    row.bySession,
    row.label,
    JSON.stringify(row.fileIds),
    row.startedAt,
  );
  const excess = (sql.exec("SELECT count(*) AS n FROM screen").toArray()[0]?.n as number) - MAX_SCREEN_ROWS;
  if (excess > 0) {
    sql.exec(
      "DELETE FROM screen WHERE session_id IN (SELECT session_id FROM screen WHERE ends_at IS NOT NULL ORDER BY ends_at, started_at LIMIT ?)",
      excess,
    );
  }
}

/** The row stays, marked ended, so the account page can still say where a file was shown; the bound prunes it. */
export const endScreenRow = (sql: SqlLike, sessionId: string, now: number): void => {
  sql.exec("UPDATE screen SET ends_at = ? WHERE session_id = ? AND ends_at IS NULL", now, sessionId);
};

/**
 * Closes every socket opened for any of these phone sessions (tag `s:<publicId>`). A repeated or unknown id closes
 * nothing more, so a retried sign-out is harmless. Returns how many sockets were closed.
 */
export function closeSessionSockets(
  sockets: { getWebSockets(tag: string): { close(code: number, reason: string): void }[] },
  publicIds: readonly string[],
  code: number,
): number {
  let closed = 0;
  for (const id of new Set(publicIds)) {
    for (const ws of sockets.getWebSockets(`s:${id}`)) {
      ws.close(code, "session ended");
      closed++;
    }
  }
  return closed;
}

/**
 * Ends each row through `end`, which answers true when its Screen confirmed the end; only a confirmed row is marked
 * ended, so a Screen that could not be reached stays listed and the next call retries it. Returns the confirmed count.
 */
export async function endScreenRows(
  sql: SqlLike,
  rows: readonly ScreenRow[],
  end: (row: ScreenRow) => Promise<boolean>,
  now: number,
): Promise<number> {
  let ended = 0;
  for (const row of rows) {
    const confirmed = await end(row).catch(() => false);
    if (!confirmed) continue;
    endScreenRow(sql, row.sessionId, now);
    ended++;
  }
  return ended;
}

export function liveScreens(sql: SqlLike): ScreenRow[] {
  return sql
    .exec("SELECT * FROM screen WHERE ends_at IS NULL ORDER BY started_at")
    .toArray()
    .map((r) => ({
      sessionId: r.session_id as string,
      screenRef: r.screen_ref as string,
      bySession: r.by_session as string,
      label: r.label as string,
      fileIds: JSON.parse(r.file_ids as string) as string[],
      startedAt: r.started_at as number,
      endsAt: null,
    }));
}

/** What an end names: one screen session, one phone session's screens, those showing one file; no field names all. */
export interface ScreenFilter {
  sessionId?: string;
  bySession?: string;
  fileId?: string;
}

export const screensMatching = (rows: readonly ScreenRow[], filter: ScreenFilter): ScreenRow[] =>
  rows.filter(
    (r) =>
      (filter.sessionId === undefined || r.sessionId === filter.sessionId) &&
      (filter.bySession === undefined || r.bySession === filter.bySession) &&
      (filter.fileId === undefined || r.fileIds.includes(filter.fileId)),
  );

export const dropScreens = (sql: SqlLike, sessionIds: readonly string[]): void => {
  for (const id of sessionIds) sql.exec("DELETE FROM screen WHERE session_id = ?", id);
};

/** The export lease: one at a time per user, expiring on its own if its end call is lost. True when taken. */
export function takeLease(sql: SqlLike, name: string, holder: string, now: number, ttlMs: number): boolean {
  const held = sql.exec("SELECT expires_at FROM lease WHERE name = ?", name).toArray()[0] as
    | { expires_at: number }
    | undefined;
  if (held && held.expires_at > now) return false;
  sql.exec("INSERT OR REPLACE INTO lease VALUES (?, ?, ?)", name, holder, now + ttlMs);
  return true;
}

/** Moves this holder's live lease on to `now + ttlMs`. An expired lease, or one another holder took, is not renewed. */
export function renewLease(sql: SqlLike, name: string, holder: string, now: number, ttlMs: number): boolean {
  const mine = sql
    .exec("SELECT 1 FROM lease WHERE name = ? AND holder = ? AND expires_at > ?", name, holder, now)
    .toArray();
  if (mine.length === 0) return false;
  sql.exec("UPDATE lease SET expires_at = ? WHERE name = ? AND holder = ?", now + ttlMs, name, holder);
  return true;
}

export const leaseHeld = (sql: SqlLike, name: string, now: number): boolean =>
  sql.exec("SELECT 1 FROM lease WHERE name = ? AND expires_at > ?", name, now).toArray().length > 0;

export const releaseLease = (sql: SqlLike, name: string, holder: string): void => {
  sql.exec("DELETE FROM lease WHERE name = ? AND holder = ?", name, holder);
};

/** The first answer stored for a key, still inside its day. */
export function idemGet(sql: SqlLike, key: string, now: number): { bodyHash: string; answer: string } | null {
  const row = sql.exec("SELECT body_hash, answer FROM idem WHERE key = ? AND expires_at > ?", key, now).toArray()[0];
  return row ? { bodyHash: row.body_hash as string, answer: row.answer as string } : null;
}

/** Keeps the first answer: a second put for a live key changes nothing. */
export function idemPut(sql: SqlLike, key: string, bodyHash: string, answer: string, now: number): void {
  sql.exec("DELETE FROM idem WHERE key = ? AND expires_at <= ?", key, now);
  sql.exec("INSERT OR IGNORE INTO idem VALUES (?, ?, ?, ?)", key, bodyHash, answer, now + DAY_MS);
}

/** Whether a row is left that a later sweep has to age out; stops at the first row of each table. */
export const rowsLeft = (sql: SqlLike): boolean =>
  sql
    .exec("SELECT EXISTS(SELECT 1 FROM progress) OR EXISTS(SELECT 1 FROM idem) OR EXISTS(SELECT 1 FROM lease) AS n")
    .toArray()[0]?.n === 1;

/** Drops what has aged out. */
export function prune(sql: SqlLike, now: number): void {
  sql.exec("DELETE FROM progress WHERE updated_at < ?", now - DAY_MS);
  sql.exec("DELETE FROM idem WHERE expires_at <= ?", now);
  sql.exec("DELETE FROM lease WHERE expires_at <= ?", now);
}

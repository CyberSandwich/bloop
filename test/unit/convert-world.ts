// A D1 with the real migrations and a library file or guest file to convert, for the convert tests.
import { addUser, type TestDb, testDb } from "./d1-shim.ts";

export interface World {
  db: TestDb;
  userId: string;
  fileId: string;
  version: number;
  /** The library original's key. */
  originalKey: string;
  prefix: string;
}

export function world(over: { ext?: string; bytes?: number; sha256?: string | null; userId?: string } = {}): World {
  const db = testDb();
  const userId = over.userId ?? "u1";
  addUser(db, userId);
  const fileId = "f1";
  const prefix = `u/${userId}/${fileId}/v1`;
  db.raw
    .prepare(
      "INSERT INTO library_file (id, user_id, name, ext, bytes, sha256, version, r2_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ready', 0, 0)",
    )
    .run(
      fileId,
      userId,
      `deck.${over.ext ?? "pptx"}`,
      over.ext ?? "pptx",
      over.bytes ?? 1000,
      over.sha256 === undefined ? "a".repeat(64) : over.sha256,
      `${prefix}/orig`,
    );
  return { db, userId, fileId, version: 1, originalKey: `${prefix}/orig`, prefix };
}

export function addGuest(db: TestDb, sessionId: string, name = "talk.pptx", bytes = 1000): string {
  const key = `g/${sessionId}`;
  db.raw
    .prepare(
      "INSERT INTO guest_file (session_id, r2_key, bytes, type, sha256, name, created_at) VALUES (?, ?, ?, 'pptx', ?, ?, 0)",
    )
    .run(sessionId, key, bytes, "c".repeat(64), name);
  return key;
}

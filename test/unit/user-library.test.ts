import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEMA_KEY } from "../../src/worker/do/schema.ts";
import {
  allProgress,
  clearProgress,
  dropScreens,
  endScreenRow,
  idemGet,
  idemPut,
  leaseHeld,
  liveScreens,
  MAX_SCREEN_ROWS,
  PROGRESS_FRAME_MS,
  prune,
  putScreen,
  recordProgress,
  releaseLease,
  rowsLeft,
  takeLease,
} from "../../src/worker/do/user-library-rules.ts";
import { initUserLibraryStorage, USER_LIBRARY_SCHEMA_VERSION } from "../../src/worker/do/user-library-schema.ts";
import { memKv, sqlOver } from "./sqlite.ts";

const open = () => {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  const kv = memKv();
  initUserLibraryStorage(sql, kv);
  return { db, sql, kv };
};
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("schema", () => {
  it("creates the four tables and records the version on a fresh object", () => {
    const { db, kv } = open();
    expect(columns(db, "progress")).toEqual(["file_id", "version", "stage", "done", "total", "updated_at"]);
    expect(columns(db, "screen")).toEqual([
      "session_id",
      "screen_ref",
      "by_session",
      "label",
      "file_ids",
      "started_at",
      "ends_at",
    ]);
    expect(columns(db, "lease")).toEqual(["name", "holder", "expires_at"]);
    expect(columns(db, "idem")).toEqual(["key", "body_hash", "answer", "expires_at"]);
    expect(kv.get(SCHEMA_KEY)).toBe(USER_LIBRARY_SCHEMA_VERSION);
  });

  it("keeps rows across a wake", () => {
    const { db, sql, kv } = open();
    idemPut(sql, "k", "h", "a", 1);
    expect(initUserLibraryStorage(sql, kv)).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM idem").get()).toEqual({ n: 1 });
  });

  it("drops and recreates a table of the wrong shape, and says which", () => {
    const { db, sql, kv } = open();
    db.exec("DROP TABLE lease");
    db.exec("CREATE TABLE lease (name TEXT PRIMARY KEY, holder TEXT, until INTEGER, extra TEXT)");
    db.exec("INSERT INTO lease VALUES ('export', 'x', 5, 'y')");
    expect(initUserLibraryStorage(sql, kv)).toEqual(["lease"]);
    expect(columns(db, "lease")).toEqual(["name", "holder", "expires_at"]);
    expect(db.prepare("SELECT count(*) AS n FROM lease").get()).toEqual({ n: 0 });
    expect(initUserLibraryStorage(sql, kv)).toEqual([]);
  });

  it("never lowers a stored version", () => {
    const { sql } = open();
    const kv = memKv({ [SCHEMA_KEY]: 9 });
    initUserLibraryStorage(sql, kv);
    expect(kv.get(SCHEMA_KEY)).toBe(9);
  });
});

describe("LIB-13 progress: frames are throttled to one a second per file", () => {
  const step = (done: number) => ({ id: "f", version: 1, stage: "render", done, total: 40 });

  it("sends the first step, then at most one a second", () => {
    const { sql } = open();
    const sent = [0, 100, 900, 1000, 1500, 2000, 2050].map((t) => recordProgress(sql, step(t), t));
    expect(sent).toEqual([true, false, false, true, false, true, false]);
  });

  it("keeps the newest counts even when no frame goes out", () => {
    const { sql } = open();
    recordProgress(sql, step(1), 0);
    recordProgress(sql, step(7), 10);
    expect(allProgress(sql)).toEqual([{ id: "f", version: 1, stage: "render", done: 7, total: 40 }]);
  });

  it("a new stage always goes out", () => {
    const { sql } = open();
    recordProgress(sql, step(1), 0);
    expect(recordProgress(sql, { ...step(0), stage: "pack" }, 5)).toBe(true);
  });

  it("is per file", () => {
    const { sql } = open();
    expect(recordProgress(sql, step(1), 0)).toBe(true);
    expect(recordProgress(sql, { ...step(1), id: "g" }, 1)).toBe(true);
    expect(PROGRESS_FRAME_MS).toBe(1000);
  });

  it("clears on done and drops after a day", () => {
    const { sql } = open();
    recordProgress(sql, step(1), 0);
    clearProgress(sql, "f", 1);
    expect(allProgress(sql)).toEqual([]);
    recordProgress(sql, step(1), 0);
    prune(sql, 86_400_001);
    expect(allProgress(sql)).toEqual([]);
  });
});

describe("live screens", () => {
  const row = (n: number, startedAt = n) => ({
    sessionId: `s${n}`,
    screenRef: `ref${n}`,
    bySession: "pub",
    label: "Room 2.14",
    fileIds: ["a", "b"],
    startedAt,
    endsAt: null,
  });

  it("holds a row until it ends, and lists only the live ones", () => {
    const { sql } = open();
    putScreen(sql, row(1));
    putScreen(sql, row(2));
    endScreenRow(sql, "s1", 50);
    expect(liveScreens(sql).map((r) => r.sessionId)).toEqual(["s2"]);
    expect(liveScreens(sql)[0]?.fileIds).toEqual(["a", "b"]);
  });

  it("keeps at most 20 rows, dropping the oldest ended one first", () => {
    const { sql, db } = open();
    for (let n = 1; n <= MAX_SCREEN_ROWS; n++) putScreen(sql, row(n));
    endScreenRow(sql, "s5", 100);
    endScreenRow(sql, "s9", 90);
    putScreen(sql, row(21));
    const ids = (db.prepare("SELECT session_id AS id FROM screen").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toHaveLength(MAX_SCREEN_ROWS);
    expect(ids).not.toContain("s9");
    expect(ids).toContain("s5");
  });

  it("with none ended, drops the oldest started", () => {
    const { sql, db } = open();
    for (let n = 1; n <= MAX_SCREEN_ROWS + 1; n++) putScreen(sql, row(n));
    expect(db.prepare("SELECT count(*) AS n FROM screen").get()).toEqual({ n: MAX_SCREEN_ROWS });
    expect(db.prepare("SELECT 1 FROM screen WHERE session_id = 's1'").get()).toBeUndefined();
  });

  it("forgets the rows it is told to", () => {
    const { sql } = open();
    putScreen(sql, row(1));
    putScreen(sql, row(2));
    dropScreens(sql, ["s1"]);
    expect(liveScreens(sql).map((r) => r.sessionId)).toEqual(["s2"]);
  });
});

describe("the export lease", () => {
  it("is held by one at a time and expires on its own", () => {
    const { sql } = open();
    expect(takeLease(sql, "export", "a", 0, 1000)).toBe(true);
    expect(takeLease(sql, "export", "b", 500, 1000)).toBe(false);
    expect(leaseHeld(sql, "export", 999)).toBe(true);
    expect(takeLease(sql, "export", "b", 1000, 1000)).toBe(true);
  });

  it("is released only by its holder", () => {
    const { sql } = open();
    takeLease(sql, "export", "a", 0, 1000);
    releaseLease(sql, "export", "b");
    expect(leaseHeld(sql, "export", 1)).toBe(true);
    releaseLease(sql, "export", "a");
    expect(leaseHeld(sql, "export", 1)).toBe(false);
  });
});

describe("the stored idempotency answer", () => {
  it("keeps the first answer for a day and then forgets it", () => {
    const { sql } = open();
    idemPut(sql, "k", "h1", "first", 0);
    idemPut(sql, "k", "h2", "second", 5);
    expect(idemGet(sql, "k", 10)).toEqual({ bodyHash: "h1", answer: "first" });
    expect(idemGet(sql, "k", 86_400_000)).toBeNull();
    idemPut(sql, "k", "h3", "third", 86_400_000);
    expect(idemGet(sql, "k", 86_400_001)?.answer).toBe("third");
  });

  it("is swept, and rowsLeft says when nothing is left to sweep", () => {
    const { sql } = open();
    expect(rowsLeft(sql)).toBe(false);
    idemPut(sql, "k", "h", "a", 0);
    expect(rowsLeft(sql)).toBe(true);
    prune(sql, 86_400_001);
    expect(rowsLeft(sql)).toBe(false);
  });
});

describe("LIB-11 hibernate: the object never holds a timer open", () => {
  const source = readFileSync(new URL("../../src/worker/do/user-library.ts", import.meta.url), "utf8");
  it.each(["setTimeout", "setInterval", ".accept("])("does not call %s", (call) => {
    expect(source).not.toContain(call);
  });
  it("answers a Close through the runtime, not a handler", () => {
    expect(source).not.toMatch(/webSocketClose|webSocketError/);
    expect(source).toContain("acceptWebSocket");
    expect(source).toContain("setWebSocketAutoResponse");
  });
});

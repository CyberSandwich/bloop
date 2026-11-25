import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DemoSlots } from "../../src/worker/do/demo-slots.ts";
import {
  DIRECTORY_SCHEMA_VERSION,
  initDirectoryStorage,
  migrateDirectory,
  ROWS_LEFT,
} from "../../src/worker/do/directory-schema.ts";
import { applySteps, SCHEMA_KEY } from "../../src/worker/do/schema.ts";
import { memKv, sqlOver } from "./sqlite.ts";

// The Directory constructor's shipped tables, version 1.
const CODE_TABLE =
  "CREATE TABLE IF NOT EXISTS code (code TEXT PRIMARY KEY, screen_ref TEXT NOT NULL, expires_at INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0)";
const MISS_TABLE =
  "CREATE TABLE IF NOT EXISTS miss (ip_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)";
const DEMO_TABLE =
  "CREATE TABLE IF NOT EXISTS demo (screen_ref TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)";

function oldShape() {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  for (const table of [CODE_TABLE, MISS_TABLE, DEMO_TABLE]) sql.exec(table);
  return { db, sql, kv: memKv() };
}

const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

const indexes = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((r) => r.name);

const plan = (db: DatabaseSync, query: string): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]).map((r) => r.detail).join("\n");

const SWEEPS = [["code", "code_expires", "DELETE FROM code WHERE expires_at <= 1"]] as const;
/** Sweeps left unindexed on purpose: an index is a billed write on each insert (directory-schema.ts step 2). */
const UNINDEXED = ["miss", "demo"] as const;

describe("Directory schema: sweep-column indexes", () => {
  it("a fresh object, with no stored version, ends with every index at the current version", () => {
    const { db, sql, kv } = oldShape();
    migrateDirectory(sql, kv);
    for (const [table, index] of SWEEPS) expect(indexes(db, table)).toContain(index);
    expect(kv.get(SCHEMA_KEY)).toBe(DIRECTORY_SCHEMA_VERSION);
  });

  it("an old-shape object, stored version 1, gains every index and the new version, rows intact", () => {
    const { db, sql, kv } = oldShape();
    kv.put(SCHEMA_KEY, 1);
    sql.exec("INSERT INTO code (code, screen_ref, expires_at) VALUES (?, ?, ?)", "123456", "ref", 5);
    migrateDirectory(sql, kv);
    for (const [table, index] of SWEEPS) expect(indexes(db, table)).toContain(index);
    expect(kv.get(SCHEMA_KEY)).toBe(DIRECTORY_SCHEMA_VERSION);
    expect(db.prepare("SELECT count(*) AS n FROM code").get()).toEqual({ n: 1 });
  });

  it("a rollback that dropped an index under the current version is repaired on the next wake", () => {
    const { db, sql, kv } = oldShape();
    migrateDirectory(sql, kv);
    db.exec("DROP INDEX code_expires");
    migrateDirectory(sql, kv);
    expect(indexes(db, "code")).toContain("code_expires");
  });

  it("re-running on wake changes nothing", () => {
    const { db, sql, kv } = oldShape();
    migrateDirectory(sql, kv);
    const schema = () => db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    const before = schema();
    migrateDirectory(sql, kv);
    expect(schema()).toEqual(before);
    expect(kv.get(SCHEMA_KEY)).toBe(DIRECTORY_SCHEMA_VERSION);
  });

  it("the sweeps search by index instead of scanning every row, which keeps them flat as rows grow", () => {
    const { db, sql, kv } = oldShape();
    migrateDirectory(sql, kv);
    for (const [, index, sweep] of SWEEPS)
      expect(plan(db, sweep)).toMatch(new RegExp(`USING (COVERING )?INDEX ${index}`));
  });

  it("miss and demo carry no index, so a guess or a demo slot costs one row write", () => {
    const { db, sql, kv } = oldShape();
    migrateDirectory(sql, kv);
    for (const table of UNINDEXED)
      expect(indexes(db, table).filter((n) => !n.startsWith("sqlite_autoindex"))).toEqual([]);
  });

  it("without the step the same sweeps scan the table", () => {
    const { db } = oldShape();
    for (const [, , sweep] of SWEEPS) expect(plan(db, sweep)).toMatch(/SCAN/);
  });

  it("the real storage init creates every table before the step indexes it", () => {
    const db = new DatabaseSync(":memory:");
    const kv = memKv();
    const slots = initDirectoryStorage(sqlOver(db), kv);
    for (const [table, index] of SWEEPS) expect(indexes(db, table)).toContain(index);
    expect(kv.get(SCHEMA_KEY)).toBe(DIRECTORY_SCHEMA_VERSION);
    expect(slots.count()).toBe(0);
  });

  it("the schema has one owner: DemoSlots creates no table, the storage init creates all three", () => {
    const bare = new DatabaseSync(":memory:");
    new DemoSlots(sqlOver(bare));
    expect(tables(bare)).toEqual([]);
    const db = new DatabaseSync(":memory:");
    initDirectoryStorage(sqlOver(db), memKv());
    expect(tables(db)).toEqual(["code", "demo", "miss"]);
  });

  it("the alarm re-arms while any table holds a row, and not once all are empty", () => {
    const { sql } = oldShape();
    const left = () => Number(sql.exec(ROWS_LEFT).toArray()[0]?.n);
    expect(left()).toBe(0);
    for (const insert of [
      "INSERT INTO code (code, screen_ref, expires_at) VALUES ('1', 'r', 1)",
      "INSERT INTO miss (ip_hash, count, window_start) VALUES ('h', 1, 1)",
      "INSERT INTO demo (screen_ref, ip_hash, expires_at) VALUES ('r', 'h', 1)",
    ]) {
      sql.exec(insert);
      expect(left()).toBe(1);
      sql.exec(`DELETE FROM ${insert.split(" ")[2]}`);
      expect(left()).toBe(0);
    }
  });
});

describe("applySteps: the stored version only rises", () => {
  it("leaves a stored version above the code's untouched", () => {
    const kv = memKv();
    kv.put(SCHEMA_KEY, 3);
    applySteps(kv, {}, 2);
    expect(kv.get(SCHEMA_KEY)).toBe(3);
  });

  it("writes a missing, malformed or lower version", () => {
    for (const stored of [undefined, "x", 1, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
      const kv = memKv();
      if (stored !== undefined) kv.put(SCHEMA_KEY, stored);
      applySteps(kv, {}, 2);
      expect(kv.get(SCHEMA_KEY)).toBe(2);
    }
  });
});

describe("sqlOver", () => {
  it("reads a WITH ... SELECT as rows and runs a write", () => {
    const sql = sqlOver(new DatabaseSync(":memory:"));
    sql.exec("CREATE TABLE t (n INTEGER)");
    sql.exec("INSERT INTO t (n) VALUES (?)", 7);
    expect(sql.exec("WITH x AS (SELECT n FROM t) SELECT n FROM x").toArray()).toEqual([{ n: 7 }]);
  });

  it("refuses a second statement in one exec instead of dropping it", () => {
    const db = new DatabaseSync(":memory:");
    const sql = sqlOver(db);
    expect(() => sql.exec("CREATE TABLE a (n INTEGER); CREATE TABLE b (n INTEGER)")).toThrow(/one statement/);
    sql.exec("CREATE TABLE c (n INTEGER);");
    expect(tables(db)).toEqual(["c"]);
  });
});

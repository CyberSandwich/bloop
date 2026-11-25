import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DemoSlots } from "../../src/worker/do/demo-slots.ts";
import {
  DIRECTORY_SCHEMA_VERSION,
  initDirectoryStorage,
  migrateDirectory,
} from "../../src/worker/do/directory-schema.ts";
import type { Kv } from "../../src/worker/do/ledger.ts";
import { applySteps, SCHEMA_KEY } from "../../src/worker/do/schema.ts";
import { sqlOver } from "./sqlite.ts";

// The Directory constructor's shipped tables, version 1.
const CODE_TABLE =
  "CREATE TABLE IF NOT EXISTS code (code TEXT PRIMARY KEY, screen_ref TEXT NOT NULL, expires_at INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0)";
const MISS_TABLE =
  "CREATE TABLE IF NOT EXISTS miss (ip_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)";

function memKv(): Kv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    put: (key, value) => void data.set(key, value),
  };
}

function oldShape() {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  sql.exec(CODE_TABLE);
  sql.exec(MISS_TABLE);
  new DemoSlots(sql);
  return { db, sql, kv: memKv() };
}

const indexes = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((r) => r.name);

const plan = (db: DatabaseSync, query: string): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]).map((r) => r.detail).join("\n");

const SWEEPS = [
  ["code", "code_expires", "DELETE FROM code WHERE expires_at <= 1"],
  ["demo", "demo_expires", "DELETE FROM demo WHERE expires_at <= 1"],
  ["miss", "miss_window", "DELETE FROM miss WHERE window_start <= 1"],
] as const;

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
    db.exec("DROP INDEX miss_window");
    migrateDirectory(sql, kv);
    expect(indexes(db, "code")).toContain("code_expires");
    expect(indexes(db, "miss")).toContain("miss_window");
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
});

describe("applySteps: the stored version only rises", () => {
  it("leaves a stored version above the code's untouched", () => {
    const kv = memKv();
    kv.put(SCHEMA_KEY, 3);
    applySteps(kv, {}, 2);
    expect(kv.get(SCHEMA_KEY)).toBe(3);
  });

  it("writes a missing, malformed or lower version", () => {
    for (const stored of [undefined, "x", 1]) {
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
});

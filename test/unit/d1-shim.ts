// A D1-shaped wrapper over node:sqlite that applies the real migrations. Every call yields once, so
// concurrent async code interleaves the way requests do against D1.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { BatchDb, Statement } from "../../src/worker/auth/db.ts";

const migrations = fileURLToPath(new URL("../../migrations", import.meta.url));

const toSql = (v: unknown): SQLInputValue => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SQLInputValue));

/** D1 refuses a statement with more bound values than this; a list that can outgrow it must be chunked. */
const D1_MAX_BINDS = 100;

class Prepared implements Statement {
  private values: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): Statement {
    if (values.length > D1_MAX_BINDS) {
      throw new Error(`D1 allows ${D1_MAX_BINDS} bound values a statement, got ${values.length}`);
    }
    this.values = values.map(toSql);
    return this;
  }
  async first<T>(): Promise<T | null> {
    await Promise.resolve();
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  async run() {
    await Promise.resolve();
    return this.runNow();
  }
  runNow() {
    const info = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(info.changes) } };
  }
  async all<T>() {
    await Promise.resolve();
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }
}

export interface TestDb extends BatchDb {
  /** Direct access for assertions and for tampering with stored rows. */
  raw: DatabaseSync;
}

/** One yield, then every statement in one transaction with no await between them, as D1 runs a batch. */
async function batch(raw: DatabaseSync, statements: Statement[]) {
  await Promise.resolve();
  raw.exec("BEGIN");
  try {
    const out = statements.map((s) => (s as Prepared).runNow());
    raw.exec("COMMIT");
    return out;
  } catch (e) {
    raw.exec("ROLLBACK");
    throw e;
  }
}

export function testDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    raw.exec(readFileSync(join(migrations, file), "utf8"));
  }
  return { raw, prepare: (sql) => new Prepared(raw, sql), batch: (statements) => batch(raw, statements) };
}

/** An app_user row, which token_grant and phone_session reference. */
export function addUser(db: TestDb, id: string, tid = "tenant-a", oid = id): void {
  db.raw
    .prepare("INSERT INTO app_user (id, tid, oid, email, created_at, last_seen_at) VALUES (?, ?, ?, NULL, 0, 0)")
    .run(id, tid, oid);
}

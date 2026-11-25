// The Directory object's storage: its tables (the shipped version 1, never edited) and the numbered steps over them,
// run on every wake by the shared `applySteps` (docs/architecture.md 8.3). `demo` belongs to DemoSlots but lives in
// this object, so its steps are numbered here.
import { DemoSlots, type SqlLike } from "./demo-slots.ts";
import type { Kv } from "./ledger.ts";
import { applySteps } from "./schema.ts";

/** Version 1 had no key: `code`, `miss` and `demo` had no index on their sweep column. */
export const DIRECTORY_SCHEMA_VERSION = 2;

const steps = (sql: SqlLike): Record<number, (kv: Kv) => void> => ({
  // 1 to 2: every sweep deletes by one column; an index keeps it from scanning every row, `miss` being the table
  // a guesser grows.
  2: () => {
    sql.exec("CREATE INDEX IF NOT EXISTS code_expires ON code (expires_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS demo_expires ON demo (expires_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS miss_window ON miss (window_start)");
  },
});

/** Call after every table exists. */
export function migrateDirectory(sql: SqlLike, kv: Kv): void {
  applySteps(kv, steps(sql), DIRECTORY_SCHEMA_VERSION);
}

/** Creates the tables, then brings them to the current shape. Returns the demo slots over the same SQL. */
export function initDirectoryStorage(sql: SqlLike, kv: Kv): DemoSlots {
  const slots = new DemoSlots(sql);
  sql.exec(
    "CREATE TABLE IF NOT EXISTS code (code TEXT PRIMARY KEY, screen_ref TEXT NOT NULL, expires_at INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS miss (ip_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)",
  );
  migrateDirectory(sql, kv);
  return slots;
}

// The Directory object's storage, the one owner of its schema: its tables (the shipped version 1, never edited) and
// the numbered steps over them, run on every wake by the shared `applySteps` (docs/architecture.md 8.3). `demo` is
// DemoSlots' table but lives in this object, so it is created and stepped here.
import { DemoSlots, type SqlLike } from "./demo-slots.ts";
import type { Kv } from "./ledger.ts";
import { applySteps } from "./schema.ts";

/** Version 1 had no key and no index on any sweep column. */
export const DIRECTORY_SCHEMA_VERSION = 2;

const steps = (sql: SqlLike): Record<number, (kv: Kv) => void> => ({
  // 1 to 2: `code` gets an index on its sweep column, since `put` and the alarm both delete by it. `miss` and `demo`
  // get none: each index is a billed row write on every insert, and `miss` takes one per failed guess, the hottest
  // path under a flood, to speed a sweep that runs every 80 s at most (ADR 0002).
  2: () => {
    sql.exec("CREATE INDEX IF NOT EXISTS code_expires ON code (expires_at)");
  },
});

/** Whether any row is left for the alarm to sweep: stops at the first row of each table, never counts them. */
export const ROWS_LEFT =
  "SELECT EXISTS(SELECT 1 FROM code) OR EXISTS(SELECT 1 FROM miss) OR EXISTS(SELECT 1 FROM demo) AS n";

/** Call after every table exists. */
export function migrateDirectory(sql: SqlLike, kv: Kv): void {
  applySteps(kv, steps(sql), DIRECTORY_SCHEMA_VERSION);
}

/** Creates the tables, then brings them to the current shape. Returns the demo slots over the same SQL. */
export function initDirectoryStorage(sql: SqlLike, kv: Kv): DemoSlots {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS code (code TEXT PRIMARY KEY, screen_ref TEXT NOT NULL, expires_at INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS miss (ip_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS demo (screen_ref TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  );
  migrateDirectory(sql, kv);
  return new DemoSlots(sql);
}

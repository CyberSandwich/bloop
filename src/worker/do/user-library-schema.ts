// The UserLibrary object's storage, the one owner of its schema (docs/library.md, ADR 0016). Every table holds
// ephemeral state (progress, live screens, leases, idempotency answers): the library itself is D1's. So step 1 is never
// edited, it is checked on every wake, and a table of any other shape is dropped and recreated rather than migrated.
import type { SqlLike } from "./demo-slots.ts";
import type { Kv } from "./ledger.ts";
import { applySteps } from "./schema.ts";

export const USER_LIBRARY_SCHEMA_VERSION = 1;

interface Table {
  name: string;
  columns: string;
}

/** Version 1. Column order is the shape: `PRAGMA table_info` must list exactly these names in this order. */
const TABLES: readonly Table[] = [
  {
    name: "progress",
    columns:
      "file_id TEXT NOT NULL, version INTEGER NOT NULL, stage TEXT NOT NULL, done INTEGER NOT NULL, total INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (file_id, version)",
  },
  {
    name: "screen",
    columns:
      "session_id TEXT PRIMARY KEY, screen_ref TEXT NOT NULL, by_session TEXT NOT NULL, label TEXT NOT NULL, file_ids TEXT NOT NULL, started_at INTEGER NOT NULL, ends_at INTEGER",
  },
  { name: "lease", columns: "name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL" },
  {
    name: "idem",
    columns: "key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, answer TEXT NOT NULL, expires_at INTEGER NOT NULL",
  },
];

const names = (columns: string): string[] =>
  columns
    .split(/,\s*(?![^()]*\))/)
    .map((c) => c.trim().split(/\s+/)[0] as string)
    .filter((n) => n !== "PRIMARY");

/** Creates what is missing and rebuilds any table whose columns differ. Returns the rebuilt names, for one log line. */
export function initUserLibraryStorage(sql: SqlLike, kv: Kv): string[] {
  const repaired: string[] = [];
  for (const { name, columns } of TABLES) {
    const have = sql.exec(`PRAGMA table_info(${name})`).toArray();
    if (have.length > 0 && have.map((c) => c.name).join() !== names(columns).join()) {
      sql.exec(`DROP TABLE ${name}`);
      repaired.push(name);
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS ${name} (${columns})`);
  }
  applySteps(kv, {}, USER_LIBRARY_SCHEMA_VERSION);
  return repaired;
}

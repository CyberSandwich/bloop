// The SpendGuard's storage schema: numbered steps, each idempotent. Every step runs on every wake, so a rollback or
// a half-applied deploy that left the data in an older shape is repaired by the next wake, and each step with its
// version write is one transaction, so a failure in the middle leaves nothing behind. Never edit a shipped step:
// add the next one (CLAUDE.md, Durable Object schema).
import type { SqlLike } from "../do/demo-slots.ts";

/** `ctx.storage.transactionSync` in the Durable Object; a BEGIN and COMMIT pair under node:sqlite in tests. */
export type Transaction = <T>(fn: () => T) => T;

const hasColumn = (sql: SqlLike, table: string, column: string): boolean => {
  const row = sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()[0];
  return new RegExp(`\\b${column}\\b`).test(String(row?.sql ?? ""));
};

const STEPS: readonly ((sql: SqlLike) => void)[] = [
  (sql) =>
    sql.exec(
      `CREATE TABLE IF NOT EXISTS counter (meter TEXT NOT NULL, scope TEXT NOT NULL, period TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (meter, scope, period)) WITHOUT ROWID;
       CREATE TABLE IF NOT EXISTS lease (id TEXT PRIMARY KEY, pool TEXT NOT NULL, scope TEXT NOT NULL, acquired_at INTEGER NOT NULL, deadline INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS trip (switch TEXT PRIMARY KEY, value TEXT NOT NULL, tripped_at INTEGER NOT NULL, reason TEXT NOT NULL, reading TEXT NOT NULL, alerted INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE IF NOT EXISTS alert (key TEXT PRIMARY KEY, day TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS override (name TEXT PRIMARY KEY, value REAL NOT NULL);
       CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS blob (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
    ),
  // The switch's row value before the breaker first tightened it, so a reset restores it ('' = no row).
  (sql) => {
    if (!hasColumn(sql, "trip", "prior")) sql.exec("ALTER TABLE trip ADD COLUMN prior TEXT NOT NULL DEFAULT ''");
  },
];

export function migrate(sql: SqlLike, transaction: Transaction): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  const stored = Number(sql.exec("SELECT version FROM schema_version WHERE id = 1").toArray()[0]?.version ?? 0);
  STEPS.forEach((step, i) => {
    transaction(() => {
      step(sql);
      if (i >= stored) sql.exec("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)", i + 1);
    });
  });
}

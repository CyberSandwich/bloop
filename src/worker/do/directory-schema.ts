// The Directory object's storage schema: numbered steps over its SQL tables (CLAUDE.md "Durable Object schema"),
// run on every wake by the shared `applySteps`. The tables themselves are the shipped version 1 and are never edited;
// `demo` belongs to DemoSlots but lives in this object, so its steps are numbered here.
import type { SqlLike } from "./demo-slots.ts";
import type { Kv } from "./ledger.ts";
import { applySteps } from "./schema.ts";

/** Version 1 had no key: `code` and `demo` had no index on `expires_at`. */
export const DIRECTORY_SCHEMA_VERSION = 2;

const steps = (sql: SqlLike): Record<number, (kv: Kv) => void> => ({
  // 1 to 2: the sweeps delete by `expires_at`; an index keeps them from scanning every row.
  2: () => {
    sql.exec("CREATE INDEX IF NOT EXISTS code_expires ON code (expires_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS demo_expires ON demo (expires_at)");
  },
});

/** Call after both tables exist. */
export function migrateDirectory(sql: SqlLike, kv: Kv): void {
  applySteps(kv, steps(sql), DIRECTORY_SCHEMA_VERSION);
}

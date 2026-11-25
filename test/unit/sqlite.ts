// Storage fakes for unit tests: SQL over node:sqlite, and the key-value API.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqlLike } from "../../src/worker/do/demo-slots.ts";
import type { Kv } from "../../src/worker/do/ledger.ts";

/** A node:sqlite database behind the slice of `ctx.storage.sql` the Directory's modules use. */
export function sqlOver(db: DatabaseSync): SqlLike {
  return {
    exec(query, ...bindings) {
      // node:sqlite compiles only the first statement and drops the rest without a word; one statement per call.
      // It errs toward refusing: a ";" inside a string literal or a comment also trips it.
      if (/;\s*\S/.test(query)) throw new Error(`one statement per exec: ${query}`);
      const statement = db.prepare(query);
      const values = bindings as SQLInputValue[];
      // Like the platform's cursor, a statement runs when exec is called, not when its rows are read.
      // A statement that returns columns (SELECT, WITH ... SELECT) is read; any other is run.
      if (statement.columns().length > 0) {
        const rows = statement.all(...values) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      statement.run(...values);
      return { toArray: () => [] };
    },
  };
}

/** `ctx.storage.kv` in memory, holding each value as put, so a test can tell a write from none; `data` is the store. */
export function memKv(entries: Record<string, unknown> = {}): Kv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(entries));
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    put: (key, value) => void data.set(key, value),
  };
}

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqlLike } from "../../src/worker/do/demo-slots.ts";

/** A node:sqlite database behind the slice of `ctx.storage.sql` the Directory's modules use. */
export function sqlOver(db: DatabaseSync): SqlLike {
  return {
    exec(query, ...bindings) {
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

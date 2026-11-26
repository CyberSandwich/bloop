// The d1 shim plus D1's atomic batch, and seeding helpers for library rows.
import type { Statement } from "../../src/worker/auth/db.ts";
import type { LibDb } from "../../src/worker/library/store.ts";
import { addUser, type TestDb, testDb } from "./d1-shim.ts";

export interface LibTestDb extends LibDb {
  raw: TestDb["raw"];
}

/** Batches run one at a time inside a transaction, as D1 runs them; a failing statement rolls the batch back. */
export function libDb(): LibTestDb {
  const db = testDb();
  let tail: Promise<unknown> = Promise.resolve();
  const batch = (statements: Statement[]) => {
    const run = tail.then(async () => {
      db.raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.raw.exec("COMMIT");
        return out;
      } catch (e) {
        db.raw.exec("ROLLBACK");
        throw e;
      }
    });
    tail = run.catch(() => undefined);
    return run;
  };
  return { raw: db.raw, prepare: (sql) => db.prepare(sql), batch };
}

export interface Seed {
  id: string;
  user?: string;
  name?: string;
  ext?: string;
  bytes?: number;
  status?: string;
  version?: number;
  updatedAt?: number;
  selectedAt?: number | null;
  trashedAt?: number | null;
  purgeAfter?: number | null;
  disabledAt?: number | null;
}

export function addFile(db: LibTestDb, s: Seed): void {
  db.raw
    .prepare(
      `INSERT INTO library_file (id, user_id, name, ext, bytes, version, r2_key, status, created_at, updated_at,
         selected_at, trashed_at, purge_after, disabled_at, crc32)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      s.id,
      s.user ?? "u1",
      s.name ?? `${s.id}.pptx`,
      s.ext ?? "pptx",
      s.bytes ?? 100,
      s.version ?? 1,
      `u/${s.user ?? "u1"}/${s.id}/v${s.version ?? 1}/orig`,
      s.status ?? "ready",
      s.updatedAt ?? 1,
      s.selectedAt ?? null,
      s.trashedAt ?? null,
      s.purgeAfter ?? null,
      s.disabledAt ?? null,
    );
}

export function libWith(users: readonly string[] = ["u1"]): LibTestDb {
  const db = libDb();
  for (const u of users) addUser(db, u);
  return db;
}

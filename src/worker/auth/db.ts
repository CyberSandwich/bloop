// The slice of D1 the auth code uses. D1Database satisfies it structurally; tests back it with node:sqlite.
// A BLOB column reads back as ArrayBuffer (or number[] in older runtimes): `bytes` normalizes it.
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface Db {
  prepare(sql: string): Statement;
}

/**
 * D1's `batch`: the statements run in order as one transaction, so no other request sees a partial result. `results`
 * holds a statement's RETURNING rows.
 */
export interface BatchDb extends Db {
  batch(statements: Statement[]): Promise<{ meta: { changes: number }; results?: Record<string, unknown>[] }[]>;
}

/** The guard of a statement batched with one that may not create the user: it runs only once the row exists. */
export const USER_EXISTS = "EXISTS (SELECT 1 FROM app_user WHERE id = ?)";

/** The one cast from the platform binding to the slice above. */
export const dbOf = (binding: unknown): BatchDb => binding as BatchDb;

export function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError("not a BLOB value");
}

/** An exact-size ArrayBuffer copy, the form D1 binds as a BLOB. */
export const blob = (view: Uint8Array): ArrayBuffer => view.slice().buffer as ArrayBuffer;

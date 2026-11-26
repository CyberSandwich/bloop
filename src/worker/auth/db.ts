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

/** A Db that also runs a batch: the statements in order as one transaction, any failure rolling all of them back. */
export interface BatchDb extends Db {
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}

/** The one cast from the platform binding to the slice above. */
export const dbOf = (binding: unknown): Db => binding as Db;

export function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError("not a BLOB value");
}

/** An exact-size ArrayBuffer copy, the form D1 binds as a BLOB. */
export const blob = (view: Uint8Array): ArrayBuffer => view.slice().buffer as ArrayBuffer;

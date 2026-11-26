// The pairing objects' Idempotency-Key adapter (R8): idem.ts owns the key check, the hashes, the window and the
// verdict; this keeps the rows in a Screen's or the Directory's KV storage under one key, bounded and shape-checked.
import type { Kv } from "../../do/ledger.ts";
import { IDEM_WINDOW_MS, type IdemStore } from "../../idem.ts";

const KEY = "idem";
/** A screen sees a claim per pairing and a few link requests; past this the oldest row goes. */
export const MAX_IDEM_ROWS = 32;

interface Row {
  owner: string;
  keyHash: string;
  bodyHash: string;
  at: number;
  stored: unknown;
}

const HASH = /^[0-9a-f]{64}$/;
const validRow = (r: unknown): r is Row => {
  const row = r as Partial<Row> | null;
  return (
    typeof row === "object" &&
    row !== null &&
    typeof row.owner === "string" &&
    typeof row.keyHash === "string" &&
    HASH.test(row.keyHash) &&
    typeof row.bodyHash === "string" &&
    HASH.test(row.bodyHash) &&
    Number.isSafeInteger(row.at) &&
    "stored" in row
  );
};

const rows = (kv: Kv): Row[] => {
  const all = kv.get<unknown>(KEY);
  return Array.isArray(all) ? all.filter(validRow) : [];
};

/** `find` for idem.ts's `idempotency()`. */
export const idemStore = <A>(kv: Kv): IdemStore<A> => ({
  find: async (owner, keyHash, since) => {
    const row = rows(kv).find((r) => r.owner === owner && r.keyHash === keyHash && r.at >= since);
    return row ? { bodyHash: row.bodyHash, stored: row.stored as A } : null;
  },
});

/** Stores a fresh key's answer, dropping rows past the window and the oldest past MAX_IDEM_ROWS. */
export function idemSave(
  kv: Kv,
  owner: string,
  fresh: { keyHash: string; bodyHash: string },
  stored: unknown,
  now: number,
): void {
  const kept = rows(kv).filter(
    (r) => r.at >= now - IDEM_WINDOW_MS && !(r.owner === owner && r.keyHash === fresh.keyHash),
  );
  kv.put(KEY, [...kept, { owner, ...fresh, at: now, stored }].slice(-MAX_IDEM_ROWS));
}

/**
 * The wake-time shape check: anything that is not a list of valid rows becomes the valid rows it holds (none if it is
 * not a list). Writes only when something was malformed, so a clean store writes nothing.
 */
export function idemRepair(kv: Kv): void {
  const all = kv.get<unknown>(KEY);
  if (all === undefined) return;
  if (Array.isArray(all) && all.every(validRow)) return;
  kv.put(KEY, rows(kv));
}

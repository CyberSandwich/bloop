// The Screen object's Idempotency-Key adapter (R8): idem.ts owns the key check, the hashes, the window and the
// verdict; this keeps the rows in the Screen's KV storage under one key, bounded and shape-checked, and derives the
// claim's owner and pid secret from HASH_PEPPER sub-keys.
import type { ClaimResponse } from "../../../shared/protocol.ts";
import type { Kv } from "../../do/ledger.ts";
import { IDEM_WINDOW_MS, type IdemStore } from "../../idem.ts";
import { base64url } from "../../ids.ts";

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
 * The wake-time check: anything that is not a list of valid rows inside the window becomes the ones it holds (none if
 * it is not a list). Writes only when something was malformed or expired, so a clean store writes nothing.
 */
export function idemRepair(kv: Kv, now: number): void {
  const all = kv.get<unknown>(KEY);
  if (all === undefined) return;
  const live = (r: Row) => r.at >= now - IDEM_WINDOW_MS;
  if (Array.isArray(all) && all.every((r) => validRow(r) && live(r))) return;
  kv.put(KEY, rows(kv).filter(live));
}

/** Drops every row: the pairing or session they answered for is gone. */
export function idemPurge(kv: Kv): void {
  const all = kv.get<unknown>(KEY);
  if (all !== undefined && !(Array.isArray(all) && all.length === 0)) kv.put(KEY, []);
}

/**
 * A claim's answer as a row keeps it: the pid's secret is never stored, only a nonce it is derived from under a
 * sub-key of HASH_PEPPER, so a leaked row without the pepper reveals no credential.
 */
export interface SealedClaim {
  nonce: string;
  answer: Omit<ClaimResponse, "pid">;
}

const encoder = new TextEncoder();

/** HMAC-SHA-256 of `message` under the sub-key HKDF derives from the pepper for `info`: one key per purpose. */
async function subKeyMac(pepper: string, info: string, message: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(pepper), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * The pid secret for `nonce`, in the 43-character form a fresh secret has, under the "bloop pid" sub-key, so the
 * pepper's other HMACs (IP, network, user pseudonym, device) share no key with it.
 */
export const claimSecret = async (pepper: string, nonce: string): Promise<string> =>
  base64url(await subKeyMac(pepper, "bloop pid", `pid:${nonce}`));

/** `X-Bloop-Nonce`: 32 random bytes as unpadded base64url, kept by the phone per tab (sessionStorage). */
export const DEVICE_NONCE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whose Idempotency-Key a claim is (REL-14): the account when signed in, else the tab's nonce under the "bloop device"
 * sub-key, so a row never holds the nonce and one address's phones never share a key. Null (no replay) without either:
 * an address is shared by a room, so it is never an owner.
 */
export async function claimOwner(pepper: string, userId: string | null, nonce: string | null): Promise<string | null> {
  if (userId !== null) return `user:${userId}`;
  if (nonce === null || !DEVICE_NONCE.test(nonce)) return null;
  return `device:${base64url(await subKeyMac(pepper, "bloop device", nonce))}`;
}

export const sealClaim = ({ pid: _, ...answer }: ClaimResponse, nonce: string): SealedClaim => ({ nonce, answer });

/** The stored answer with its pid derived again, or null for a row not in the sealed shape. */
export async function openClaim(v: unknown, screenRef: string, pepper: string): Promise<ClaimResponse | null> {
  const s = v as Partial<SealedClaim> | null;
  if (typeof s?.nonce !== "string" || typeof s.answer !== "object" || s.answer === null) return null;
  return { ...s.answer, pid: `${screenRef}.${await claimSecret(pepper, s.nonce)}` };
}

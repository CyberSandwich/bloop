// Randomness and hashing for handles, codes and match codes. Web Crypto only, so it runs in the
// Worker and in Node tests alike.
import { ALPHABET } from "../../public/js/shared/codes.js";

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** Uniform integer in [0, max) for max <= 256, by rejection sampling: `byte % max` alone is biased. */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max < 1 || max > 256) throw new RangeError("max must be an integer in 1..256");
  const limit = 256 - (256 % max);
  for (;;) {
    const [byte] = randomBytes(1) as unknown as [number];
    if (byte < limit) return byte % max;
  }
}

export const drawCode = (length: number): string =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/** Two digits, "00" to "99", fresh per claim. */
export const drawMatch = (): string => String(randomInt(100)).padStart(2, "0");

/** 128-bit routing handle. Not a secret (ADR 0002). */
export const newRef = (): string => base64url(randomBytes(16));
/** 256-bit secret. Only its hash is stored. */
export const newSecret = (): string => base64url(randomBytes(32));

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** HMAC-SHA-256 hex, used to pseudonymize an IP with HASH_PEPPER. IPs are never stored raw. */
export async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(text))));
}

/** Compares two strings without an early exit on the first differing character. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const CREDENTIAL = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/** `sid` and `pid` are `ref.secret`. Returns null for anything else. */
export function parseCredential(text: string): { ref: string; secret: string } | null {
  const m = CREDENTIAL.exec(text);
  return m ? { ref: m[1] as string, secret: m[2] as string } : null;
}

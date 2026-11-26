// Preview tokens (LIB-04): `p1.<kid>.<claims>.<mac>`, a bearer for one file version and one asset kind, good for at most
// 300 s. The /p/ handler verifies it, then runs the serving predicate with the owner from the row, so a token proves
// only that bloop minted it for this file lately, never that the file is still servable.
import { base64url, hmacHex, safeEqual, sha256Hex } from "../ids.ts";

export const PREVIEW_TTL_MS = 300_000;

export type Asset = "bundle" | "original";

export interface Claims {
  /** File id. */
  f: string;
  /** The version the token was minted for; a row at another version refuses it. */
  v: number;
  a: Asset;
  /** Epoch ms. */
  exp: number;
}

const encoder = new TextEncoder();

/** A key's public name: the token says which key signed it, so a rotation needs no guessing. */
export const keyId = async (key: string): Promise<string> => (await sha256Hex(key)).slice(0, 8);

const fromBase64url = (text: string): string => {
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** `ttlMs` is clamped to the 300 s ceiling. */
export async function mintPreview(key: string, claims: Omit<Claims, "exp">, now: number, ttlMs = PREVIEW_TTL_MS) {
  const exp = now + Math.min(ttlMs, PREVIEW_TTL_MS);
  const head = `p1.${await keyId(key)}.${base64url(encoder.encode(JSON.stringify({ ...claims, exp })))}`;
  return { token: `${head}.${await hmacHex(key, head)}`, exp };
}

const isClaims = (c: unknown): c is Claims => {
  const x = c as Partial<Claims> | null;
  return (
    typeof x?.f === "string" &&
    Number.isSafeInteger(x.v) &&
    (x.a === "bundle" || x.a === "original") &&
    Number.isSafeInteger(x.exp)
  );
};

/**
 * The claims of a token signed by one of `keys` (the current key, then the one before a rotation), or null. Shape first,
 * then the MAC in constant time, then the clock; a token from the previous key dies by its own `exp`, at most 300 s on.
 */
export async function verifyPreview(keys: readonly string[], token: string, now: number): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "p1") return null;
  const [, kid, body, mac] = parts as [string, string, string, string];
  for (const key of keys) {
    if (kid !== (await keyId(key))) continue;
    if (!safeEqual(mac, await hmacHex(key, `p1.${kid}.${body}`))) return null;
    try {
      const claims: unknown = JSON.parse(fromBase64url(body));
      return isClaims(claims) && claims.exp > now && claims.exp <= now + PREVIEW_TTL_MS ? claims : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Cookie parsing and the one cookie format: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, so the
// `__Host-` prefix is valid (the browser then refuses any cookie that weakens these). Browsers treat
// http://localhost as secure, so the prefix works in local dev.
import { base64url, randomBytes } from "../ids.ts";
import { fromBase64 } from "./vault.ts";

export const SESSION_COOKIE = "__Host-bloop_sid";
export const OAUTH_COOKIE = "__Host-bloop_oauth";

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export const setCookie = (name: string, value: string, maxAgeSeconds: number): string =>
  `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;

export const clearCookie = (name: string): string => setCookie(name, "", 0);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const aeadKey = (cookieKey: string) =>
  crypto.subtle.importKey("raw", fromBase64(cookieKey), "AES-GCM", false, ["encrypt", "decrypt"]);

/** AES-GCM with the cookie's name as AAD, so one sealed cookie cannot stand in for another. */
export async function sealCookie(cookieKey: string, name: string, payload: unknown): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
      await aeadKey(cookieKey),
      encoder.encode(JSON.stringify(payload)),
    ),
  );
  return base64url(Uint8Array.from([...iv, ...ct]));
}

/** The payload, or null for anything that is not a cookie this key sealed under this name. */
export async function openCookie(cookieKey: string, name: string, value: string): Promise<unknown | null> {
  try {
    const bytes = fromBase64(value.replaceAll("-", "+").replaceAll("_", "/"));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(name) },
      await aeadKey(cookieKey),
      bytes.slice(12),
    );
    return JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
}

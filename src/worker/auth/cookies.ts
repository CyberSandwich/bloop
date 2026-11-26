// Cookie parsing and the one cookie format: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, so the
// `__Host-` prefix is valid (the browser then refuses any cookie that weakens these). Browsers treat
// http://localhost as secure, so the prefix works in local dev. No bloop cookie is readable by page script.
import { base64url, randomBytes } from "../ids.ts";
import { SESSION_MAX_AGE_SECONDS } from "./sessions.ts";
import { fromBase64 } from "./vault.ts";

export const SESSION_COOKIE = "__Host-bloop_sid";
export const OAUTH_COOKIE = "__Host-bloop_oauth";
/** `1` beside a member session, read only by the server to pick the landing's Library link; it grants nothing. */
export const HINT_COOKIE = "__Host-bloop_in";
/** The known-device value (codes.ts `newDeviceValue`): kept across a plain sign-out, cleared by sign out everywhere. */
export const DEVICE_COOKIE = "__Host-bloop_dev";
/** The WebAuthn ceremony binder (ADR 0014), SameSite=Strict. TRANSITIONAL(a-5): the passkey routes set it. */
export const BIND_COOKIE = "__Host-bloop_bind";
/** `open` while an admin previews the open site (ADR 0026); the page still checks the admin session per request. */
export const VIEW_COOKIE = "__Host-bloop_view";

/** TRANSITIONAL(a-5): the passkey routes set the binder with it. */
export const BIND_MAX_AGE_SECONDS = 600;
/** The longest Max-Age a browser keeps (Chrome caps a cookie at 400 days). */
export const DEVICE_MAX_AGE_SECONDS = 400 * 86_400;
/** One working session: a forgotten preview ends by itself the same day. */
export const VIEW_MAX_AGE_SECONDS = 8 * 3_600;

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

/** The same format with SameSite=Strict: a cross-site navigation never carries it. TRANSITIONAL(a-5): the binder. */
export const setStrict = (name: string, value: string, maxAgeSeconds: number): string =>
  `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Strict`;

/**
 * Every cookie a member sign-in sets, in one place. `deviceValue` is null when the device cookie stays as it is.
 * TRANSITIONAL(a-4): code verify is the first caller.
 */
export const signedInCookies = (session: string, deviceValue: string | null): string[] => [
  setCookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SECONDS),
  setCookie(HINT_COOKIE, "1", SESSION_MAX_AGE_SECONDS),
  ...(deviceValue ? [setCookie(DEVICE_COOKIE, deviceValue, DEVICE_MAX_AGE_SECONDS)] : []),
];

/** Every cookie a sign-out clears. A plain sign-out keeps the device known; sign out everywhere forgets it too. */
export const signedOutCookies = ({ everywhere }: { everywhere: boolean }): string[] => [
  clearCookie(SESSION_COOKIE),
  clearCookie(HINT_COOKIE),
  ...(everywhere ? [clearCookie(DEVICE_COOKIE)] : []),
];

/** A response header set with one Set-Cookie per cookie. */
export function withCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

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

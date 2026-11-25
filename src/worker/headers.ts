// The one header policy (docs/architecture.md section 10). public/_headers must produce the same
// values for static pages; test/unit/headers.test.ts enforces it.

// `landing` is also the static default (`/*` in _headers): Cloudflare does not detach `/*`'s CSP on the root path,
// so the root receives the default too. No page under it fetches anything or has a manifest, so it carries neither
// `connect-src` nor `manifest-src`; a page that needs one changes `/*` in _headers and this policy together
// (test/unit/headers.test.ts).
export type Policy = "landing" | "app" | "screen" | "api" | "file-pptx" | "file-pdf" | "file-image";

const PERMISSION_FEATURES = [
  "accelerometer",
  "autoplay",
  "browsing-topics",
  "camera",
  "display-capture",
  "encrypted-media",
  "fullscreen",
  "geolocation",
  "gyroscope",
  "hid",
  "idle-detection",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "xr-spatial-tracking",
];

/** Features the screen page `/s` keeps for itself. */
const SCREEN_ALLOWED = new Set(["fullscreen", "screen-wake-lock"]);

export function permissionsPolicy(screen = false): string {
  return PERMISSION_FEATURES.map((f) => `${f}=${screen && SCREEN_ALLOWED.has(f) ? "(self)" : "()"}`).join(", ");
}

export const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": permissionsPolicy(),
};

const PAGE_TAIL =
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'; upgrade-insecure-requests";
const SELF = "script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'";

export const CSP: Readonly<Record<Policy, string>> = {
  landing: `default-src 'none'; ${SELF}; ${PAGE_TAIL}`,
  app: `default-src 'none'; ${SELF}; connect-src 'self'; ${PAGE_TAIL}`,
  // The screen page plays a guest video from its own origin; no blob: and no other host.
  screen: `default-src 'none'; ${SELF}; media-src 'self'; connect-src 'self'; ${PAGE_TAIL}`,
  api: "default-src 'none'; frame-ancestors 'none'",
  "file-pptx": "default-src 'none'; sandbox; frame-ancestors 'none'",
  // `object-src 'self'` is the one hole: Chromium's PDF viewer is an embedded plugin, which the
  // `default-src 'none'` fallback would block (ADR 0003, field check F-PDF). `sandbox` stays out: it stops the viewer.
  "file-pdf": "default-src 'none'; object-src 'self'; frame-ancestors 'none'",
  // A photo or video, read by the screen page (its canvas, its <video>); opened on its own, the document is sandboxed
  // with an opaque origin and plays nothing, so the screen never opens it in a window.
  "file-image": "default-src 'none'; sandbox; frame-ancestors 'none'",
};

const EXTRA: Readonly<Record<Policy, Record<string, string>>> = {
  landing: {},
  app: {},
  screen: {},
  api: { "Cache-Control": "no-store" },
  "file-pptx": { "Content-Disposition": "attachment", "Cache-Control": "no-store" },
  "file-pdf": { "Content-Disposition": "inline", "Cache-Control": "no-store" },
  "file-image": { "Content-Disposition": "inline", "Cache-Control": "no-store" },
};

export function headersFor(policy: Policy): Record<string, string> {
  return { ...BASE_HEADERS, "Content-Security-Policy": CSP[policy], ...EXTRA[policy] };
}

const chosen = new WeakMap<Response, Policy>();

/** Lets a handler pick the policy for one response, where the route's own policy does not fit (/f/ files). */
export function withPolicy(response: Response, policy: Policy): Response {
  chosen.set(response, policy);
  return response;
}

/** The policy a handler chose for this response, else the route's. */
export const policyOf = (response: Response, fallback: Policy): Policy => chosen.get(response) ?? fallback;

/** Returns a copy of `response` with the policy applied; the policy wins over anything already set. */
export function withHeaders(response: Response, policy: Policy): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headersFor(policy))) out.headers.set(name, value);
  return out;
}

// The one header policy (docs/architecture.md section 10). public/_headers must produce the same
// values for static pages; test/unit/headers.test.ts enforces it.

// `landing` is also the static default (`/*` in _headers): Cloudflare does not detach `/*`'s CSP on the root path,
// so the root receives the default too. No page under it fetches anything or has a manifest, so it carries neither
// `connect-src` nor `manifest-src`; a page that needs one changes `/*` in _headers and this policy together
// (test/unit/headers.test.ts).
export type Policy =
  | "landing"
  | "app"
  | "screen"
  | "library"
  | "auth"
  | "api"
  | "file-origin"
  | "file-pptx"
  | "file-pdf"
  | "file-image";

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
  "publickey-credentials-create",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "xr-spatial-tracking",
];

/** Features a page keeps for itself: the screen page `/s`, and the sign-in pages (passkeys, ADR 0014). */
const PAGE_FEATURES = {
  none: new Set<string>(),
  screen: new Set(["fullscreen", "screen-wake-lock"]),
  auth: new Set(["publickey-credentials-create", "publickey-credentials-get"]),
};
type PermissionPage = keyof typeof PAGE_FEATURES;

export function permissionsPolicy(page: PermissionPage = "none"): string {
  return PERMISSION_FEATURES.map((f) => `${f}=${PAGE_FEATURES[page].has(f) ? "(self)" : "()"}`).join(", ");
}

/** The permissions a policy's pages keep. */
const PAGE_OF: Readonly<Partial<Record<Policy, PermissionPage>>> = { screen: "screen", auth: "auth" };

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

const PAGE_HEAD = "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script';";
const PAGE_TAIL = `${PAGE_HEAD} trusted-types 'none'; upgrade-insecure-requests`;
/** The one Trusted Types policy (public/js/core/tt.js): the viewers' worker URLs, an exact allowlist (ADR 0020). */
const WORKER_TAIL = `${PAGE_HEAD} trusted-types bloop-worker; upgrade-insecure-requests`;
const SELF = "script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'";
const TURNSTILE = "https://challenges.cloudflare.com";

export const CSP: Readonly<Record<Policy, string>> = {
  landing: `default-src 'none'; ${SELF}; ${PAGE_TAIL}`,
  app: `default-src 'none'; ${SELF}; connect-src 'self'; ${PAGE_TAIL}`,
  // The screen page plays a guest video from its own origin and runs the viewers' workers; the file origin is added
  // at serve time (`pageCsp`).
  screen: `default-src 'none'; ${SELF}; media-src 'self'; connect-src 'self'; worker-src 'self'; ${WORKER_TAIL}`,
  // The library page is the app policy plus what the screen page has, so previews play; the file origin and the R2
  // endpoint are added at serve time.
  library: `default-src 'none'; ${SELF}; media-src 'self'; connect-src 'self'; worker-src 'self'; ${WORKER_TAIL}`,
  // Sign-in, invite, account, admin and report: the app policy plus the Turnstile widget (ADR 0022).
  auth: `default-src 'none'; script-src 'self' ${TURNSTILE}; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src ${TURNSTILE}; ${PAGE_TAIL}`,
  api: "default-src 'none'; frame-ancestors 'none'",
  // The workers.dev host answers only what it must (ADR 0018); a document there could run nothing.
  "file-origin": "default-src 'none'; sandbox; frame-ancestors 'none'",
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
  library: {},
  auth: {},
  // X-Bloop marks an answer as ours, so the client can tell a campus filter's block page from a real reply.
  api: { "Cache-Control": "no-store", "X-Bloop": "1" },
  // A cross-origin probe from the app reads it (ADR 0018); the handler adds Access-Control-Allow-Origin.
  "file-origin": { "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-store" },
  "file-pptx": { "Content-Disposition": "attachment", "Cache-Control": "no-store" },
  "file-pdf": { "Content-Disposition": "inline", "Cache-Control": "no-store" },
  "file-image": { "Content-Disposition": "inline", "Cache-Control": "no-store" },
};

export function headersFor(policy: Policy): Record<string, string> {
  return {
    ...BASE_HEADERS,
    "Permissions-Policy": permissionsPolicy(PAGE_OF[policy]),
    "Content-Security-Policy": CSP[policy],
    ...EXTRA[policy],
  };
}

/**
 * `csp` with `sources` appended to `directive`, which is added when absent. How the file origin and the R2 EU
 * endpoint reach the policies: both come from configuration, so the static `_headers` cannot carry them.
 */
export function withSources(csp: string, directive: string, sources: readonly string[]): string {
  if (sources.length === 0) return csp;
  const parts = csp.split("; ");
  const at = parts.findIndex((p) => p === directive || p.startsWith(`${directive} `));
  if (at < 0) parts.splice(1, 0, `${directive} ${sources.join(" ")}`);
  else parts[at] = `${parts[at]} ${sources.join(" ")}`;
  return parts.join("; ");
}

/** What a page's CSP gains at serve time. Null entries add nothing. */
export interface PageSources {
  fileOrigin: string | null;
  r2Endpoint: string | null;
}

/** Pages whose policy is completed at serve time: the policy, and which of the two sources each takes. */
export const DYNAMIC_PAGES: Readonly<Record<string, { policy: Policy; file: boolean; r2: boolean }>> = {
  "/s": { policy: "screen", file: true, r2: false },
  "/a": { policy: "app", file: false, r2: true },
  "/library": { policy: "library", file: true, r2: true },
};

/** The full CSP of a dynamic page, or null for any other path. */
export function pageCsp(page: string, sources: PageSources): string | null {
  const spec = DYNAMIC_PAGES[page];
  if (!spec) return null;
  let csp = CSP[spec.policy];
  const file = spec.file && sources.fileOrigin ? [sources.fileOrigin] : [];
  const r2 = spec.r2 && sources.r2Endpoint ? [sources.r2Endpoint] : [];
  if (file.length > 0) {
    for (const directive of ["img-src", "media-src"]) csp = withSources(csp, directive, file);
  }
  return withSources(csp, "connect-src", [...file, ...r2]);
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

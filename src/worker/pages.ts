// Which static page answers a path, by launch mode (ADR 0026). Every non-dynamic request passes through `servePage`,
// so the rules below hold whatever the asset layer would do with the raw path.
import { readCookie, SESSION_COOKIE } from "./auth/cookies.ts";
import { servicesFor } from "./auth/services.ts";
import { type Config, configFor } from "./config.ts";
import { DYNAMIC_PAGES, pageCsp, withHeaders } from "./headers.ts";
import { fail } from "./http.ts";
import { admitted, type LaunchState, launchState } from "./mode.ts";
import { pillRequest, withAccountPill } from "./nav-pill.ts";
import { AUTH_SHELLS, MEMBER_PAGES, VARIANTS, type Variant } from "./page-registry.ts";

const SHELLS: ReadonlySet<string> = new Set(AUTH_SHELLS);
const MEMBERS: ReadonlySet<string> = new Set(MEMBER_PAGES);

/** The slice of Env this module uses, so Node-side tests can import it (the Worker's Env needs the workers-types). */
export interface PageEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: unknown;
}

/** A path no file has, so the asset layer answers its own 404 page: a hidden page looks exactly like a missing one. */
const MISSING = "/.missing";
/** An admin who holds this cookie with a live admin session sees the open pages while the site is in preview. */
const VIEW_COOKIE = "__Host-bloop_view";

/**
 * The path the rules look at: percent-decoded once, repeated slashes collapsed, dot segments resolved. Null (answer
 * 404) when it still holds `%` or `\`, when it is not valid UTF-8 escapes, or when its first segment is `open` in any
 * letter case: no request string reaches the open subtree except through a listed variant in open mode.
 */
export function normalizePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("%") || decoded.includes("\\")) return null;
  const segments: string[] = [];
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  if (segments[0]?.toLowerCase() === "open") return null;
  return `/${segments.join("/")}`;
}

const fetchAs = (
  env: Pick<PageEnv, "ASSETS">,
  request: Request,
  path: string,
  headers: Headers = request.headers,
): Promise<Response> => env.ASSETS.fetch(new Request(new URL(path, request.url), { method: request.method, headers }));

const notFound = (env: Pick<PageEnv, "ASSETS">, request: Request): Promise<Response> => fetchAs(env, request, MISSING);

/**
 * The 404 a plain asset or a refused path answers. In open mode a browser navigation gets the open 404 page (its own
 * nav), still with status 404; every other request, and preview, keeps today's. The mode is read only for a navigation.
 */
async function missing(env: PageEnv, request: Request, plain: Response): Promise<Response> {
  if (!(request.headers.get("Accept") ?? "").includes("text/html")) return plain;
  if ((await launchState(env)).mode !== "open") return plain;
  // The 404 is never a 304: a revalidation would hand back today's page.
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const page = await fetchAs(env, request, "/open/404", headers);
  return page.status === 200
    ? withAccountPill(request, new Response(page.body, { status: 404, headers: page.headers }))
    : plain;
}

/** The build output path of a variant's open file: `/` is `/open`, because `/open/` would be redirected. */
const openAsset = (path: string): string => (path === "/" ? "/open" : `/open${path}`);

const noindex = (response: Response): Response => {
  const out = new Response(response.body, response);
  out.headers.set("X-Robots-Tag", "noindex");
  return out;
};

/** A page whose visibility depends on the cookie: no shared cache may keep or reuse it. */
const privateCopy = (response: Response): Response => {
  const out = new Response(response.body, response);
  out.headers.set("Cache-Control", "private, no-store");
  out.headers.append("Vary", "Cookie");
  return out;
};

/** The active member email of the request's session, or null. */
async function memberEmail(request: Request, env: PageEnv, config: Config): Promise<string | null> {
  const cookie = readCookie(request, SESSION_COOKIE);
  const userId = cookie ? await servicesFor(env, config).sessions.resolve(cookie) : null;
  return userId ? servicesFor(env, config).sessions.activeMemberEmail(userId) : null;
}

/** An admin's own preview of the open site: the view cookie plus a session that is an ADMIN_EMAILS member right now. */
async function adminViewing(request: Request, env: PageEnv): Promise<boolean> {
  if (readCookie(request, VIEW_COOKIE) !== "open") return false;
  const config = configFor(env);
  if (!config.ok) return false;
  try {
    const email = await memberEmail(request, env, config.config);
    return email !== null && config.config.account.adminEmails.has(email);
  } catch {
    console.error("admin_view_check_failed");
    return false;
  }
}

/**
 * Whether the page shows in preview: a session of an email member the lockout admits, and for /admin an address in
 * ADMIN_EMAILS. An Entra user is not a member of the invite-only product, so they see what a signed-out visitor sees.
 */
async function memberVisible(
  request: Request,
  env: PageEnv,
  config: Config,
  state: LaunchState,
  path: string,
): Promise<boolean> {
  try {
    const email = await memberEmail(request, env, config);
    if (email === null || !admitted(state, config.account, email)) return false;
    return path !== "/admin" || config.account.adminEmails.has(email);
  } catch {
    // A database error hides the page like any other doubt; it never shows it and never answers 500.
    console.error("member_page_check_failed");
    return false;
  }
}

/**
 * Answers a static request: a 404 for any form of `/open`, the mode's file for a listed variant, the preview rules for
 * the account pages, else the plain asset. The mode is read only for a path that needs it.
 */
export async function servePage(
  original: Request,
  env: PageEnv,
  variants: readonly Variant[] = VARIANTS,
): Promise<Response> {
  const url = new URL(original.url);
  const path = normalizePath(url.pathname);
  if (path === null) return missing(env, original, await notFound(env, original));
  // The path that was checked is the path that is served.
  const request =
    path === url.pathname ? original : new Request(new URL(`${path}${url.search}`, original.url), original);
  const variant = variants.find((v) => v.path === path);
  // The file forms of a gated page (`/library.html`, `/library/index.html`) and its other letter cases are the page.
  const key = path.replace(/(\/index)?\.html$/i, "").toLowerCase() || "/";
  // The 404 page is no page of its own: asked for by name it answers as any unknown path does, in either mode.
  if (key === "/404") return missing(env, request, await notFound(env, request));
  // An open-only page has no file of its own in `public/`, so its `.html` forms redirect here, as the asset layer does for the rest.
  const bare = path.replace(/(\/index)?\.html$/, "");
  if (bare !== path && variants.some((v) => v.kind === "open-only" && v.path === bare)) {
    return (await launchState(env)).mode === "open"
      ? new Response(null, { status: 307, headers: { Location: `${bare}${url.search}`, "Cache-Control": "no-cache" } })
      : asset(env, request, path);
  }
  const shell = SHELLS.has(key);
  const member = MEMBERS.has(key);
  if (!variant && !shell && !member) return asset(env, request, path);
  // /admin acts on the owner's word, so it never trusts a cached mode (ADR 0026).
  const state = await launchState(env, { fresh: key === "/admin" });
  if (shell || member) {
    if (state.mode === "open") return asset(env, request, path);
    if (shell) return noindex(await asset(env, request, path));
    const config = configFor(env);
    return config.ok && (await memberVisible(request, env, config.config, state, key))
      ? privateCopy(await asset(env, request, path))
      : notFound(env, request);
  }
  if (!variant) return asset(env, request, path);
  const viewing = state.mode !== "open" && (await adminViewing(request, env));
  if (state.mode !== "open" && !viewing) {
    return variant.kind === "open-only" ? notFound(env, request) : asset(env, request, path);
  }
  const answer =
    variant.kind === "preview-only"
      ? new Response(null, { status: 301, headers: { Location: variant.to ?? "/", "Cache-Control": "no-cache" } })
      : await openFile(env, request, variant, url.search);
  return viewing ? noindex(privateCopy(answer)) : answer;
}

/** A variant's open file. A redirect from the asset layer would leak the build path, so it is a fault, never passed on. */
async function openFile(env: PageEnv, request: Request, variant: Variant, search: string): Promise<Response> {
  const target = new URL(`${openAsset(variant.path)}${search}`, request.url);
  const response = await asset(env, new Request(target, pillRequest(request)), variant.path);
  if (response.status >= 300 && response.status <= 399 && response.status !== 304) {
    console.error("variant_redirect");
    return withHeaders(fail("internal"), "api");
  }
  // A 404 is missing()'s, which already carries the pill.
  return response.status === 404 ? response : withAccountPill(request, response);
}

/** The asset, with the policy of a page whose sources come from configuration completed (headers.ts `pageCsp`). */
async function asset(env: PageEnv, request: Request, path: string): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return missing(env, request, response);
  const config = configFor(env);
  // A 304 too: a browser replaces its stored headers with the revalidation's, so it must carry the same policy.
  if (!(path in DYNAMIC_PAGES) || ![200, 304].includes(response.status) || !config.ok) return response;
  const { fileOrigin, uploadMode } = config.config.library;
  const { r2AccountId } = config.config.secrets;
  const csp = pageCsp(path, {
    fileOrigin,
    r2Endpoint: uploadMode === "direct" && r2AccountId ? `https://${r2AccountId}.eu.r2.cloudflarestorage.com` : null,
  });
  if (!csp) return response;
  const out = new Response(response.body, response);
  out.headers.set("Content-Security-Policy", csp);
  return out;
}

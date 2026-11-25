// Which static page answers a path, by launch mode (ADR 0026). Every non-dynamic request passes through `servePage`,
// so the rules below hold whatever the asset layer would do with the raw path.
import { readCookie, SESSION_COOKIE } from "./auth/cookies.ts";
import { servicesFor } from "./auth/services.ts";
import { type Config, configFor } from "./config.ts";
import { DYNAMIC_PAGES, pageCsp } from "./headers.ts";
import { admitted, type LaunchState, launchState } from "./mode.ts";

/** The slice of Env this module uses, so Node-side tests can import it (the Worker's Env needs the workers-types). */
export interface PageEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: unknown;
}

/**
 * A page whose file differs by mode. `both`: the path exists in both modes with different files (the open one sits
 * under /open/ in the build output at the same relative path). `open-only`: 404 in preview. `preview-only`: 301 to `to`
 * in open. The site stream fills this list when it emits the open files; empty, no page differs and no mode is read.
 */
export interface Variant {
  path: string;
  kind: "both" | "open-only" | "preview-only";
  to?: string;
}
export const VARIANTS: readonly Variant[] = [];

/** Served and linked in open; in preview served unlinked and noindex, so test accounts reach them on the real host. */
const AUTH_SHELLS: ReadonlySet<string> = new Set(["/signin", "/invite"]);
/** Need a session: in preview a signed-out request, or one the lockout refuses, gets the 404 any unknown path gets. */
const MEMBER_PAGES: ReadonlySet<string> = new Set(["/library", "/account", "/admin"]);
/** A path no file has, so the asset layer answers its own 404 page: a hidden page looks exactly like a missing one. */
const MISSING = "/.missing";

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

const notFound = (env: Pick<PageEnv, "ASSETS">, request: Request): Promise<Response> =>
  env.ASSETS.fetch(new Request(new URL(MISSING, request.url), { method: request.method, headers: request.headers }));

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
  const { sessions } = servicesFor(env, config);
  const cookie = readCookie(request, SESSION_COOKIE);
  const userId = cookie ? await sessions.resolve(cookie) : null;
  if (!userId) return false;
  const email = await sessions.emailNorm(userId);
  if (email === null || !admitted(state, config.account, email)) return false;
  return path !== "/admin" || config.account.adminEmails.has(email);
}

/**
 * Answers a static request: a 404 for any form of `/open`, the mode's file for a listed variant, the preview rules for
 * the account pages, else the plain asset. The mode is read only for a path that needs it.
 */
export async function servePage(
  request: Request,
  env: PageEnv,
  variants: readonly Variant[] = VARIANTS,
): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  if (path === null) return notFound(env, request);
  const variant = variants.find((v) => v.path === path);
  // The file forms of a gated page (`/library.html`, `/library/index.html`) and its other letter cases are the page.
  const key = path.replace(/(\/index)?\.html$/i, "").toLowerCase() || "/";
  const shell = AUTH_SHELLS.has(key);
  const member = MEMBER_PAGES.has(key);
  if (!variant && !shell && !member) return asset(env, request, path);

  const state = await launchState(env);
  if (variant) {
    if (state.mode === "open") {
      if (variant.kind === "preview-only") {
        return new Response(null, {
          status: 301,
          headers: { Location: variant.to ?? "/", "Cache-Control": "no-cache" },
        });
      }
      return env.ASSETS.fetch(new Request(new URL(`/open${variant.path}${url.search}`, url), request));
    }
    return variant.kind === "open-only" ? notFound(env, request) : asset(env, request, path);
  }
  if (state.mode === "open") return asset(env, request, path);
  if (shell) return noindex(await asset(env, request, path));
  const config = configFor(env);
  return config.ok && (await memberVisible(request, env, config.config, state, key))
    ? privateCopy(await asset(env, request, path))
    : notFound(env, request);
}

/** The asset, with the policy of a page whose sources come from configuration completed (headers.ts `pageCsp`). */
async function asset(env: PageEnv, request: Request, path: string): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
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

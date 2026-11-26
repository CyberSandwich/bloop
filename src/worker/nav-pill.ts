// The open site's account pill: "Sign In" for a visitor, "Library" for one who holds the `__Host-bloop_in` hint cookie.
// The Worker swaps the label while serving the page, not a script, so a signed-in visitor never sees Sign In flash
// (docs/ux/landing.md section 2.1). The pill's markup is the build's (tools/build-pages.mjs ACCOUNT_PILL); a unit test
// holds every open page to it, and a page that does not match is served as written: the Sign In state, never broken.
import { readCookie } from "./auth/cookies.ts";

export const HINT_COOKIE = "__Host-bloop_in";
export const PILL_OUT =
  '<a class="btn account" href="/signin" data-account><span>Sign In</span><span aria-hidden="true">Library</span></a>';
const PILL_IN =
  '<a class="btn account" href="/library" data-account><span aria-hidden="true">Sign In</span><span>Library</span></a>';
// The signed-in copy of a page is a different body under the same file, so it gets its own ETag. Without this a
// browser holding the signed-out copy would send that ETag after signing in, the asset layer would answer 304, and
// the visitor would keep seeing Sign In.
const IN = "-in";

const signedIn = (request: Request): boolean => readCookie(request, HINT_COOKIE) === "1";

/**
 * The request the asset layer sees. A signed-in visitor's `If-None-Match` is translated back to the file's own ETag
 * when it names the signed-in copy, and dropped when it names any other copy (or none), so the answer is a 304 only
 * for the copy the browser really holds. `If-Modified-Since` is dropped for the same reason.
 */
export function pillRequest(request: Request): Request {
  if (!signedIn(request)) return request;
  const headers = new Headers(request.headers);
  const own = (headers.get("If-None-Match") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.endsWith(`${IN}"`))
    .map((tag) => `${tag.slice(0, -IN.length - 1)}"`);
  if (own.length > 0) headers.set("If-None-Match", own.join(", "));
  else headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  return new Request(request, { headers });
}

/** An open-mode HTML answer, varied by the cookie; a signed-in visitor's gets Library and its own ETag. */
export async function withAccountPill(request: Request, response: Response): Promise<Response> {
  if (!(response.headers.get("Content-Type") ?? "").includes("text/html")) return response;
  const headers = new Headers(response.headers);
  if (!/\bcookie\b/i.test(headers.get("Vary") ?? "")) headers.append("Vary", "Cookie");
  if (!signedIn(request)) return new Response(response.body, { status: response.status, headers });
  const etag = headers.get("ETag");
  if (etag) headers.set("ETag", etag.replace(/"$/, `${IN}"`));
  if (response.status === 304) return new Response(null, { status: 304, headers });
  // A new body is plain text: its length and encoding are no longer the asset's.
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  return new Response((await response.text()).replace(PILL_OUT, PILL_IN), { status: response.status, headers });
}

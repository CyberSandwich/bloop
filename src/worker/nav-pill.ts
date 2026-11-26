// The open site's account pill: "Sign In" for a visitor, "Library" for one who holds the `__Host-bloop_in` hint cookie.
// The Worker swaps the label while serving the page, not a script, so a signed-in visitor never sees Sign In flash
// (docs/ux/landing.md section 2.1). The markup is src/shared/account-pill.ts, which the build writes too; a page that
// does not hold it is served as written: the Sign In state, never broken.
import { ACCOUNT_PILL_IN, ACCOUNT_PILL_OUT } from "../shared/account-pill.ts";
import { readCookie } from "./auth/cookies.ts";

export const HINT_COOKIE = "__Host-bloop_in";
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
  // A byte range of the asset is not a range of the rewritten body.
  headers.delete("Range");
  headers.delete("If-Range");
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
  // Some shared caches ignore Vary: Cookie, so the signed-in copy is never stored by one.
  headers.set("Cache-Control", "private, no-cache");
  if (response.status === 304) return new Response(null, { status: 304, headers });
  // The new body's length is not the asset's.
  headers.delete("Content-Length");
  const body = request.method === "HEAD" ? null : (await response.text()).replace(ACCOUNT_PILL_OUT, ACCOUNT_PILL_IN);
  return new Response(body, { status: response.status, headers });
}

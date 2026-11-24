import { withHeaders } from "./headers.ts";
import { fail } from "./http.ts";

/**
 * A request that did not arrive at PUBLIC_ORIGIN (the old workers.dev host, plain http) moves for good to the same
 * path and query there. Anything but a plain GET or HEAD is refused instead: a body is never replayed to another origin,
 * and an already-open page on the old host gets a definite answer, not a redirect its fetch or socket cannot follow.
 * Returns null for a request already on the origin, and when PUBLIC_ORIGIN is not a URL (the config check reports that).
 * It reads the variable alone, so the redirect works even when the rest of the config is invalid.
 */
export function offOrigin(request: Request, publicOrigin: string): Response | null {
  if (!URL.canParse(publicOrigin)) return null;
  const origin = new URL(publicOrigin).origin;
  const url = new URL(request.url);
  if (url.origin === origin) return null;
  const plain = (request.method === "GET" || request.method === "HEAD") && !request.headers.has("Upgrade");
  if (!plain) return withHeaders(fail("forbidden_origin"), "api");
  return withHeaders(
    new Response(null, { status: 301, headers: { Location: origin + url.pathname + url.search } }),
    "landing",
  );
}

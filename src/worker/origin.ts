import { withHeaders } from "./headers.ts";
import { fail } from "./http.ts";

/**
 * A request that did not arrive at PUBLIC_ORIGIN (the old workers.dev host, plain http) moves for good to the same
 * path and query there. Anything but a plain GET or HEAD is refused instead: a body is never replayed to another origin,
 * and an already-open page on the old host gets a definite answer, not a redirect its fetch or socket cannot follow.
 * Returns null for a request that is already on the origin.
 */
export function offOrigin(request: Request, origin: string): Response | null {
  const url = new URL(request.url);
  if (url.origin === origin) return null;
  const plain = (request.method === "GET" || request.method === "HEAD") && !request.headers.has("Upgrade");
  if (!plain) return withHeaders(fail("forbidden_origin"), "api");
  return withHeaders(
    new Response(null, { status: 301, headers: { Location: origin + url.pathname + url.search } }),
    "landing",
  );
}

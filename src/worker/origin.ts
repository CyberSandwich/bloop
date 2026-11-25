import { withHeaders } from "./headers.ts";
import { fail } from "./http.ts";

/** What the file-origin host serves itself. The present-server change adds /f/, /b/ and /p/ here. */
const FILE_ORIGIN_PATHS: ReadonlySet<string> = new Set(["/fo/ping"]);

/**
 * Two kinds of request move to PUBLIC_ORIGIN: one for a workers.dev host (the old address), and one for the origin's own
 * hostname over plain http. A GET or HEAD answers 301 to the same path and query; anything else (a write, a WebSocket
 * upgrade) is refused with 403, so a body is never replayed to another origin and an already-open old page gets a
 * definite answer. Every other host, a local address included, passes to the Origin and config checks. The redirect
 * expires after an hour, so a mistake cannot stick in a browser. It reads PUBLIC_ORIGIN alone, so it works even when the
 * rest of the config is invalid; null when PUBLIC_ORIGIN is not a URL (the config check reports that).
 * The file origin (ADR 0018) answers only FILE_ORIGIN_PATHS, whatever its hostname; every other path on it moves too.
 */
export function offOrigin(request: Request, publicOrigin: string, fileOrigin?: string): Response | null {
  if (!URL.canParse(publicOrigin)) return null;
  const target = new URL(publicOrigin);
  const url = new URL(request.url);
  if (url.origin === target.origin) return null;
  const isFileHost = Boolean(fileOrigin) && url.origin === fileOrigin;
  if (isFileHost && FILE_ORIGIN_PATHS.has(url.pathname)) return null;
  const oldHost = isFileHost || url.hostname.endsWith(".workers.dev");
  const plainHttp = url.protocol === "http:" && target.protocol === "https:" && url.hostname === target.hostname;
  if (!oldHost && !plainHttp) return null;
  const plain = (request.method === "GET" || request.method === "HEAD") && !request.headers.has("Upgrade");
  if (!plain) return withHeaders(fail("forbidden_origin"), "api");
  return withHeaders(
    new Response(null, {
      status: 301,
      headers: { Location: target.origin + url.pathname + url.search, "Cache-Control": "max-age=3600" },
    }),
    "landing",
  );
}

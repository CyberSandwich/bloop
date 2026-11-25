# ADR 0023: caching

Status: accepted. Supersedes the asset-bypass idea ("option C") from the host-split review. Page variants by mode: ADR 0026.

## Context
- Every request reaches the Worker first (`run_worker_first: true`, ADR 0010). The Worker serves static files from the asset binding and decides the host, the mode variant and the headers.
- v4 adds third-party viewer libraries (immutable by name), user files on another host (never cacheable by a shared cache), and HTML that differs by launch mode, so a stale HTML copy would show the wrong mode.
- The asset layer would serve files without waking the Worker if `run_worker_first` were narrowed to API paths. That is cheaper per request, but it bypasses the host split, the path normalizer and the mode variants.

## Decision
`run_worker_first: true` stays. The Worker serves every path, and the asset binding answers with the headers below.

| response | Cache-Control |
|---|---|
| HTML, and JS and CSS with unhashed names | `no-cache` with an ETag, so a browser revalidates and gets a 304 |
| `/js/vendor/<lib>-<version>/` | `public, max-age=31536000, immutable` |
| fonts (version-suffixed names) | `public, max-age=31536000, immutable` |
| `/img` | `public, max-age=86400, stale-while-revalidate=604800` |
| `/api`, `/f` | `no-store` |
| `/b`, `/p`, and the notes routes | `no-store`: the library can be opened on a shared computer |

- **HTML is never immutable.** The two mode variants (ADR 0026) have different ETags, so after a switch the next revalidation returns the other page with a 200. No purge, no deploy.
- **A vendored library is immutable because its folder carries its version.** An upgrade is a new folder and a new URL; the old one is deleted with the code that named it.
- **`/f` is `no-store`** (links are single-session secrets). **`/b` and `/p` are `private`** so a shared cache never keeps a user's file; five minutes matches the preview token's life.

### What the foundation change ships
- The vendored immutable rule and the file-origin classes (`/f`, `/b`, `/p`, `/fo/ping`) are set where their handlers and headers live (`_headers` and `src/worker/headers.ts`), so they apply when a stream adds the first vendored folder or file-origin route.
- The `/img` and font rules are **not applied** by the foundation change. Today's images and font keep their current headers, so no live behavior changes. Each rule ships with the stream that renames the assets with a version suffix or adds the new ones.

## Rejected
- **Option C, asset-bypass:** narrow `run_worker_first` to `/api`, `/f`, `/auth` and the new routes. It saves a Worker invocation per static request, but the asset layer would then answer on the `workers.dev` host too, so the site itself would be served from the file origin, and the path normalizer and the variant choice would never run on pages.
- **Long max-age on HTML with purge on switch:** a purge is a second mechanism, and a missed purge shows the wrong mode.
- **`public` on `/b` and `/p`:** a shared cache could hold a user's file past its trash or disable.

## Consequences
- Each static request costs a Worker invocation; the spend guard owns the ceiling.
- The unhashed JS and CSS revalidate on every page load; ETag 304s keep the cost to headers.
- Workers Cache stays off (a test pins `wrangler.jsonc` to it): a hit would skip the Worker, so the mode gate and headers would not run, and its key ignores the host.

## Threats served
LIB-03 (a trashed or disabled file is not kept by a cache), LIB-05 and FO-01 (file-origin responses carry their own headers), MODE-01 (no stale variant outlives the 30 s mode window).

## How to remove it
If the Worker invocation cost ever dominates, narrow `run_worker_first` with an explicit path list and move the host and variant logic to a rule that runs before the asset layer. Delete the table's rows with the assets they name.

# ADR 0023: caching

Status: accepted. Page variants by mode: ADR 0026.

## Context
- Every page and API request reaches the Worker first (`run_worker_first`, ADR 0010); the static trees (`/js`, `/css`, `/img`, `/fonts`, the icons) do not. The Worker serves pages from the asset binding and decides the host, the mode variant and the headers.
- v4 adds third-party viewer libraries (immutable by name), user files on another host (never cacheable by a shared cache), and HTML that differs by launch mode, so a stale HTML copy would show the wrong mode.
- The asset layer serves the static trees without waking the Worker, which is cheaper per request. Pages stay behind the Worker, which owns the host split, the path normalizer and the mode variants.

## Decision
`run_worker_first` lists every path but the static trees. The Worker serves every page, the asset layer answers the static trees, and both answer with the headers below.

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
- **`/f` is `no-store`** (links are single-session secrets). **`/b` and `/p` are `no-store`**: the library can be opened on a shared computer, so a preview stays in memory.

### What the foundation change ships
- The vendored immutable rule and the file-origin classes (`/f`, `/b`, `/p`, `/fo/ping`) are set where their handlers and headers live (`_headers` and `src/worker/headers.ts`), so they apply when a stream adds the first vendored folder or file-origin route.
- `/fonts` and `/js/vendor` are immutable in `_headers`, and the build refuses a file in either folder whose path has no version (`4.1`, `0.1.3`); `/img` is cached a day. The workers.dev redirect of `/f`, `/b`, `/p` and `/fo` is `no-store`, since the path is the secret.

## Rejected
- **Option C, asset-bypass for pages:** narrow `run_worker_first` to `/api`, `/f`, `/auth` and the new routes. The asset layer would then answer pages on the `workers.dev` host too, so the site itself would be served from the file origin, and the path normalizer and the variant choice would never run on pages. Only the static trees are bypassed.
- **Long max-age on HTML with purge on switch:** a purge is a second mechanism, and a missed purge shows the wrong mode.
- **`public` on `/b` and `/p`:** a shared cache could hold a user's file past its trash or disable.

## Consequences
- Each page and API request costs a Worker invocation; the spend guard owns the ceiling. A static asset costs none, on any host.
- The unhashed JS and CSS revalidate on every page load; ETag 304s keep the cost to headers.
- Workers Cache stays off (a test pins `wrangler.jsonc` to it): a hit would skip the Worker, so the mode gate and headers would not run, and its key ignores the host.

## Threats served
LIB-03 (a trashed or disabled file is not kept by a cache), LIB-05 and FO-01 (file-origin responses carry their own headers), MODE-01 (no stale variant outlives the 30 s mode window).

## How to remove it
If the Worker invocation cost ever dominates, narrow `run_worker_first` with an explicit path list and move the host and variant logic to a rule that runs before the asset layer. Delete the table's rows with the assets they name.

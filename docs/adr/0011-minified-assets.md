# ADR 0011: minified assets

Status: accepted

## Context
wrangler served `public/` as written, so every comment in a browser module cost every visitor bytes, and the size budgets, which measured the same raw files, pushed builders to delete comments that carried a trap or an invariant. ADR 0001 keeps native ES modules with no bundler: lazy `import()` entries load only on intent, and each page's static import closure is its own budget.

## Decision
- **One file at a time.** `tools/build-assets.mjs` copies `public/` to `dist/` byte for byte, except each `.js` module, which esbuild's `transform` minifies on its own (`format: esm`, `minify: true`, no bundle). Specifiers, `import()` calls and export names stay as written, so the module graph, the lazy entries and any future `modulepreload` list are the same files at the same paths. `test/unit/build-assets.test.ts` checks every module keeps its exports and imports and gains no string-to-code sink (Trusted Types and the CSP are unchanged).
- **Target `safari15.4`**, the browser floor (design.md): syntax past it is lowered, and syntax that cannot be lowered fails the build. License comments (`/*!`, the vendored QR file's) stay.
- **wrangler serves `dist/`.** `wrangler.jsonc` sets `assets.directory` to `./dist` and `build.command` to its CLI (`tools/build-assets-cli.mjs`), so `wrangler dev` (`npm run dev`, the integration helper, Playwright, Lighthouse) and `wrangler deploy` rebuild it before they serve or upload, and dev rebuilds on any change under `public/`. A changed file is written to a per-process temp name beside its target and renamed over it, so a server never reads half a file and two builds never share one; a file gone from `public/` is deleted from `dist/` before anything is written, and a path that changed between file and folder is cleared. `test/integration/pages.test.ts` holds every served module equal to a fresh build of its source. `dist/` is gitignored and never committed.
- **Order:** the page build (`content/` to `public/*.html`, ADR 0001) runs first and stays a committed, CI-checked output; `npm run build` runs both, and `npm run check` checks the pages, then builds the assets.
- **Budgets measure what ships:** every JS `size-limit` entry measures the built module in `dist/`, and `docs-drift.test.ts` reads each entry's module graph from the source it builds. Source comments cost no visitor a byte, so comments stay.
- **Source maps:** written beside each module (`/js/<file>.map`, the source inside, named by its file so the browser's tools show it at `/js/<file>`), served, never linked: no `sourceMappingURL`, so no visitor downloads even the comment. A developer attaches the map in the browser's tools by hand. The repo is public, so the map exposes nothing new.
- **CSS stays as written.** A CSS minifier merges rules with the same body into one selector list, and a lone `:popover-open` rule must stay apart so an engine that does not know it drops only that rule (design.md); the gzipped saving is worth a check on the built CSS first.
- **Dependency:** `esbuild`, exact pin, dev only, the same version wrangler already installs (it bundles the Worker with it). Replaces: serving raw source, and trimming comments to fit a budget. Remove: set `assets.directory` back to `./public`, delete `build` from `wrangler.jsonc`, the script, its tests and the pin, point the JS `size-limit` entries at `public/js/` again and re-baseline them.

## Rejected
- **Bundling** (esbuild or Rollup bundles per page): fewer requests, but it merges the lazy modules' shared code, renames chunks, and needs hashing to stay cacheable; per-file output keeps every path and budget as it is.
- **Content hashing in file names:** a lazy `import()` of an old hash 404s after a deploy (the caching decision in the v3.3 plan), and it needs a step that rewrites HTML and specifiers.
- **Stripping comments only:** saves less than minifying and still needs a parser to be safe; esbuild is already installed.
- **Terser or SWC:** a new dependency tree for a few percent.

## Consequences
- A served file is never the source: debug with the map, or read the source in the repo.
- `_headers`, `_redirects` and `.assetsignore` are copied with the rest, so header and routing rules apply to `dist/` unchanged; a `run_worker_first` path list names the same URL paths.

# ADR 0018: the file origin and the present links

Status: proposed. Amends ADR 0003 (open path). The pairing rules and the serving predicate are ADR 0015's; cache headers are ADR 0023's.

## Context
- A user's own file is now served to a screen page that runs bloop's code. Served from the app's origin, a crafted file that a browser renders as a document would run with the app's cookies and storage.
- The screen's viewers (ADR 0015) read derived assets (slide packs, a PDF, video) for one item, many requests per talk, not one file per link.
- The owner's library previews (`/p/`) are signed tokens; the signing key must be able to rotate without breaking every open preview.

## Decision
- **A separate file origin.** `FILE_ORIGIN` (the workers.dev host today) serves only `/f/`, `/b/`, `/p/` and `/fo/ping` (`src/worker/origin.ts`); every other path on it moves to `PUBLIC_ORIGIN`. It never reads or sets a cookie, and every answer is sandboxed (`default-src 'none'; sandbox`, nosniff) with CORS open to `PUBLIC_ORIGIN` only. Why: the browser's same-origin rule keeps a file away from the app. Replaces: user bytes on the app's host. Remove: unset `FILE_ORIGIN`; links mint on `PUBLIC_ORIGIN` as before.
- **The link origin is the screen's choice, made once.** The screen probes `/fo/ping`, and its hello says `fo: "file"` or `"main"`. Only that hello, before approval, sets it; a phone or a link request cannot (FO-01). `"main"` mints on `PUBLIC_ORIGIN`, where the same file-origin headers apply.
- **A `bundle` link purpose.** One link per viewer item: `/b/<token>/<asset>`, where the asset is one of a fixed allowlist mapped to fixed storage keys and types (interfaces.md section 4). It lives until the session ends, like `view`, with no time window. It is a link purpose, not an open mode: `LINK_PURPOSES` is `OPEN_MODES` plus `"bundle"`. Why: one revocable credential per item instead of a link per asset. Remove: mint one `view` link per asset.
- **A `library` FileSource kind** (ADR 0015 decides it). An item's ref is `fileId:version`, and every fetch re-runs the serving predicate for the pinned user. Its order is Up Next's (ADR 0009).
- **Preview tokens carry a key id:** `p1.<kid>.<payload>.<mac>`. `kid` names the `FILE_TOKEN_KEY` that signed it; the verifier accepts the current key and, for 300 s after a rotation, the previous one. An unknown `kid` is the same 404 as a bad mac. Why: a rotation would otherwise break every preview open at that moment. Remove: drop `kid` and accept one key.
- **The 5 s verdict cache** (the rule is ADR 0015's) is a per-isolate map keyed by link hash and file version. A refusal is never stored. Why: a video's range reads would each cost a D1 read. No Cache API or KV entry, so nothing outlives the isolate. Remove: delete the map; every fetch reads D1.
- No new dependency.

## Rejected
- **Serving files from the app's origin under a strict CSP:** one header mistake on one route would let a file run as the app.
- **A link per bundle asset:** a slide pack of several widths and pages would spend the mint budget and multiply ledger rows.
- **Caching verdicts across isolates:** a revocation would then outlive the 5 s bound.

## Consequences
- The screen page makes cross-origin requests, so the file origin answers preflights for `PUBLIC_ORIGIN` only.
- A network that blocks workers.dev falls back to the main host, with the residual stated on FO-01.

## Threats served
FO-01, LIB-03, LIB-04, NOTES-01 (no bundle path reaches notes), SRC-01.

## How to remove it
Per line above. The origin split goes last: unset `FILE_ORIGIN`, and `origin.ts` sends the workers.dev host to `PUBLIC_ORIGIN` again.

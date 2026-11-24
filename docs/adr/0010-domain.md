# ADR 0010: the bloop.here domain

Status: accepted

## Context
The Worker served on a workers.dev address, a name that is long to type, says nothing, and ties links and QR codes to a platform subdomain. `bloop.here` is registered and its DNS zone is active in the same Cloudflare account as the Worker. The zone holds only the iCloud mail records for `hi@bloop.here`.

## Decision
- **Worker custom domain:** `routes: [{ pattern: "bloop.here", custom_domain: true }]` in `wrangler.jsonc`. Cloudflare creates the apex DNS record and the certificate on deploy, so no record is added by hand and the mail records are never touched. A route plus a hand-made proxied record would be two things to keep in step; this is one.
- **`PUBLIC_ORIGIN` is `https://bloop.here`.** It stays the one public address: the `Origin` checks, the QR and `/f/` links and the `{host}/code` line all derive from it or from the page's own host.
- **One redirect rule, in the Worker:** any request that is not on `PUBLIC_ORIGIN` (the old workers.dev host, plain http, any other host) answers 301 to the same path and query there, before routing (`src/worker/origin.ts`). A write or a WebSocket upgrade on such a host answers 403 `forbidden_origin` instead: a body is never replayed to another origin, and an already-open old page gets a definite refusal, which its backoff treats as a failed read, not a loop. `workers_dev` stays on so old links and QR codes keep working. Replaces: a zone Redirect Rule, which cannot see the workers.dev host.
- **`run_worker_first: true`**, because a static page on the old host must reach the Worker to be redirected. Cost: static requests count as Worker requests (free plan: 100,000 a day). An asset request does only the origin comparison and `ASSETS.fetch` (no D1 or Durable Object call), and keeps its `_headers` (`test/integration/site.test.ts`). Remove: once workers.dev traffic is gone, set `workers_dev: false`, restore the path list in `run_worker_first` and drop `origin.ts`.
- **No `www.bloop.here`.** Nothing links to it, a second custom domain adds a record and a certificate to keep, and the redirect already answers any extra host if one is added later with one more `routes` entry.
- **Contact:** one address, `hi@bloop.here`, on the pages and in `security.txt`. The Waitlist is the Tally form `https://tally.so/r/Yj4KAN?source=<page>`; Tally is named as the processor on `/privacy`.

## Consequences
- Anything stored per origin starts over on the new host: a phone's pairing in `localStorage`, and a registered room's `__Host-` cookie (the room enrolls again). An Entra app registration needs `https://bloop.here/auth/callback` before `FILE_SOURCE=graph`.
- `wrangler dev` needs `--infer-origin-from-routes=false`, or it tells the Worker its host is `bloop.here`.
- The deploy token must be allowed to attach a custom domain (`docs/setup.md`).

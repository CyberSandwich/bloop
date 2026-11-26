# Owner setup

Steps only the owner can do, because they need the owner's accounts. Everything else runs locally with `FILE_SOURCE=mock` and needs none of this. How CI and deploy fit together is in [architecture.md](architecture.md) section 12.

## First deploy, in order

1. **Cloudflare account** (Workers Paid), then `npx wrangler login` on your own machine.
2. **D1:** `npx wrangler d1 create bloop --jurisdiction eu`; put the printed id into `wrangler.jsonc` `database_id` (it is all zeros now) and commit it. Then `npx wrangler d1 migrations apply bloop --remote`.
3. **R2:** the bucket and its lifecycle rule, in the next section.
4. **Worker secrets**, each with `npx wrangler secret put <NAME>` (the v4 secrets are in "Secrets for v4" below): `COOKIE_KEY`, `HASH_PEPPER`, `TOKEN_KEKS` (JSON of key id to base64 key, as in `.dev.vars.example`; `TOKEN_KEK_CURRENT` in `vars` names the current key), `IT_EXPORT_TOKEN` (optional; the export stays closed without it), `ENTRA_CLIENT_SECRET` (only with the Entra step). Generate each with `openssl rand -base64 32`; never reuse the `.dev.vars` values. If an earlier deploy set `ROOM_ENROLL_KEY`, delete it: `npx wrangler secret delete ROOM_ENROLL_KEY` (nothing reads it).
5. **GitHub:** the owner's settings script holds the repo's settings: features, merge options, a default-branch ruleset (no deletion, no force push, linear history; direct pushes to `main` still work), a tag ruleset, Actions locked to GitHub-owned actions with a read-only token, Dependabot, secret scanning with push protection, private vulnerability reporting, CodeQL, and the `production` environment (`main` only, no required reviewer: a push to `main` deploys once `npm run check` passes in the job). It needs `gh` logged in, so it runs outside the Claude Code sandbox. In order:
   0. Once, in Terminal (interactive): `gh auth refresh -h github.com -s read:user`, so the script can read the account plan.
   1. Plan: shows every difference and writes nothing.
   2. Apply: changes only what differs and prints each change. Lines starting `!` are left for you (visibility, unknown collaborators, keys or hooks, a missing `SECURITY.md`).
   3. Secrets, in Terminal since it prompts with hidden input: asks for `CLOUDFLARE_API_TOKEN` (an account API token, Manage account, Account API tokens, so it is not tied to a person: Workers Editor and D1 Edit, plus Containers and Cloudchamber Edit once conversion ships, no R2 Storage permission (the lifecycle rules are a one-off owner step below), no IP filter since runner IPs change, 1-year expiry; check the scope in the dashboard and widen nothing) and `CLOUDFLARE_ACCOUNT_ID` and stores them as `production` environment secrets. `deploy.yml` hands the token to the wrangler steps alone. Until they exist, the deploy workflow passes and only prints a skip notice.
   4. Check: exits 1 on any drift; rerun it after changing settings by hand.
6. **Placeholders:** replace the addresses and the absolute `og:image` per "Site pages" below.
7. **Address:** the Worker serves at `https://bloop.here` (`PUBLIC_ORIGIN` and the `routes` custom domain in `wrangler.jsonc`; ADR 0010). The zone is in the same Cloudflare account and the first deploy creates the apex DNS record and certificate, so there is nothing else to click: never add an apex A, AAAA or CNAME by hand, and never touch the zone's iCloud mail records (MX, SPF, DKIM, DMARC, apple-domain TXT). DNSSEC is done at the registrar (Porkbun): the DS record from the zone's DNS settings. The deploy token must be allowed to attach a custom domain: if the first deploy refuses it, add Zone Read and DNS Edit on the `bloop.here` zone to the token. The old workers.dev address stays enabled and answers 301 to the same path on `bloop.here`, so old links and QR codes keep working; `www.bloop.here` has no record and no route. With Entra on, add `https://bloop.here/auth/callback` as a Web redirect URI before switching `FILE_SOURCE` to `graph`.
8. **Deploy:** merge or push to `main`; the `production` run deploys after the check passes.
9. **Edge** (threat model SITE-09; all in the Cloudflare dashboard, on the `bloop.here` zone):
   1. Security, Security rules (or Security, WAF): confirm the Cloudflare managed ruleset shows **Enabled**.
   2. Security, Security rules, Create rule, **Rate limiting rule**: expression `starts_with(http.request.uri.path, "/api/")`; characteristics IP; 300 requests per 10 seconds; action Block for 10 seconds. `/f/` is outside the expression, so a video's range reads are never counted.
   3. Security, Security rules, Create rule, **Custom rule**: expression `starts_with(http.request.uri.path,"/f/") or http.request.uri.path in {"/api/screen/ws" "/api/pair/ws"}`; action **Skip**, ticking Security Level and Browser Integrity Check. The skip covers only those two features, so rule order does not matter.
   4. Security, Settings: **Bot Fight Mode** off (on Free it cannot be scoped, and it challenges the phone API and the sockets).
   5. Scrape Shield (or Content Protection): **Email Address Obfuscation** off and **Server-side Excludes** off.
   6. SSL/TLS, Edge Certificates: **Automatic HTTPS Rewrites** off.
   7. Speed, Optimization, Protocol Optimization: **0-RTT Connection Resumption** off (a POST in early data can be replayed).
   8. Turnstile stays unset; revisit on abuse. Leave `workers.dev` enabled: `saputra.co.uk` still redirects there, and turning it off is a later step.
   9. Check: `curl -s -o /dev/null -w "%{http_code}\n" https://bloop.here/api/health` answers 200, a phone pairs and a video plays on a real lectern, and the dashboard's Security Events shows no challenge on `/f/` or the sockets.

## Checks only a person can do

- **Header grade:** after deploy, `npx @mdn/mdn-http-observatory "$PUBLIC_ORIGIN"` should grade A or better.
- **Browser walk:** allow `127.0.0.1` and `localhost` once in Claude in Chrome, so every page and state can be checked at 1440, 834 and 390 locally. CI's Playwright and axe runs cover the same pages on every push.
- **QR from 2 m:** on a real lectern screen, scan `/s` from the back of the front row with three phones (iPhone camera, Android camera, Android Chrome).
- **Field test T3** on a lectern PC (below), including the PDF view and residue check.
- **Five-person test** (design open item 19): five people who have never seen bloop read the landing for five seconds, then say what it does and what they would do next.
- **Publisher verification** in Entra needs a company (Microsoft Partner Network id); until then, consent screens show "unverified".
- **Privacy roles:** decide controller or processor per buyer type (threat model DATA-01) and update `/privacy` and `/terms` when a buyer agreement changes them.

## Cloudflare R2 bucket for guest files

Guest uploads (ADR 0005) live in one private R2 bucket in the `eu` jurisdiction. Local runs need none of this: `wrangler dev` emulates the bucket and D1.

1. **Create the bucket** with the name `wrangler.jsonc` binds (`GUEST_FILES`): `npx wrangler r2 bucket create bloop-guest-files --jurisdiction eu`. Leave it private: no public bucket URL, no custom domain, no `r2.dev` subdomain. Objects are read only through the Worker, by key, for a session's `/f/` link.
2. **The 1-day lifecycle rule** is a backstop for the session-end delete and the hourly sweep. Wrangler config cannot express it, so it is a file, `tools/r2-lifecycle.json` (delete objects under `g/` after 86,400 s; abort stale multipart uploads). **This is a one-off owner step, not part of any deploy**: run `npx wrangler r2 bucket lifecycle set bloop-guest-files --file tools/r2-lifecycle.json --jurisdiction eu --force` once, with a token that can write R2 storage (your own login or a short-lived account token, not the deploy token). `deploy.yml` does not apply it, so the deploy token needs no R2 Storage Write; rerun the command only when the file changes. The same rule can be set in the dashboard (R2, the bucket, Settings, Object lifecycle rules: "Delete uploaded objects after 1 day", prefix `g/`). Check it with `npx wrangler r2 bucket lifecycle list bloop-guest-files --jurisdiction eu`: it must show `guest-files-1-day`. The API rejects a rule without a `conditions` block as "not well formed", so the abort rule carries an empty prefix.
3. **The card.** R2 may ask for a payment method before the first bucket, even though the free tier (10 GB stored, a million writes and 10 million reads a month) is far above what guest drops use (unverified: Cloudflare's plan terms change). If you decline, the guest drop cannot run: the documented fallback (guest bytes as chunks in the Screen object, ADR 0005) is not built. `GUEST_DROP=off` refuses live drops only: a demo screen still takes drops, so R2 is needed whenever `DEMO_ENABLED` is true. To refuse every drop, set `DEMO_ENABLED=false` as well; remove the `r2_buckets` binding only together with the fallback.
4. **The limits** are plain variables in `wrangler.jsonc`: `GUEST_DROP` (`open`, `pass` or `off`), `GUEST_MAX_BYTES` (90 MB for every file type; the platform allows at most 100 MB per request body), `DEMO_GUEST_MAX_BYTES` (25 MB), `DEMO_MAX_CONCURRENT` (demo screens alive at once), `DEMO_MAX_PER_IP` (demo screens one address may hold) and `GUEST_STORAGE_BUDGET_BYTES` (5 GiB of live guest files; above it drops get "bloop can't take files right now."). The `RL_UPLOAD` binding (5 uploads a minute per address) is in the same file.
   **The R2 free-tier hard stop.** R2 is the only product on the account that can bill, and it has no spending cap, so bloop stops itself. It counts its own R2 operations per calendar month (UTC): class A (put, list) against `R2_CLASS_A_MONTHLY_CAP` (default 500,000; free tier 1,000,000) and class B (get, head) against `R2_CLASS_B_MONTHLY_CAP` (default 5,000,000; free tier 10,000,000), each at 50% of the free tier because the billing period may not align with calendar months and any 30 days span two; a single delete is free and not counted (the sweep's bulk delete counts as one class A). At a cap, drops get "bloop can't take files right now." and `/f/` reads of guest files fail with `upstream_failed`, until the month rolls over. Storage (10 GB free) is held by `GUEST_STORAGE_BUDGET_BYTES` (5 GiB). Read the counters with `npx wrangler d1 execute bloop --remote --command "select month, class, n from r2_ops order by month desc, class"`. The counts are bloop's own: operations outside the Worker are not metered. The lifecycle rule's own deletes are Cloudflare's, and browsing the bucket in the dashboard lists and reads, so do not browse it. The other half of the free tier is the headroom for these. Turn on a Cloudflare billing notification (dashboard, Billing, Notifications) as a second warning.
5. **After the first deploy**, run `wrangler tail`, send a file from a phone through a live screen, open it, End the session, and confirm the object is gone: `npx wrangler r2 object get bloop-guest-files/<key> --remote --jurisdiction eu` should fail with "not found". The key is in the D1 `guest_file` row (`wrangler d1 execute bloop --remote --command "select r2_key, deleted_at from guest_file order by created_at desc limit 1"`).

### The library bucket

Create it before the first deploy that carries the v4 bindings: migrations apply first, so a deploy that then fails on a missing binding leaves 0005 applied under the old code. Both buckets are created once, in the `eu` jurisdiction, by the owner; `deploy.yml` does not check them.

User files (v4) live in a second private bucket in the `eu` jurisdiction, bound as `LIBRARY`: `npx wrangler r2 bucket create bloop-library --jurisdiction eu`. It has no public URL. Its one lifecycle rule aborts incomplete multipart uploads after 1 day, set once with the same token as above (dashboard: R2, the bucket, Settings, Object lifecycle rules). Never add an expiry rule to this bucket: files stay until the user deletes them. CORS on both buckets allows only the `https://bloop.here` origin, the PUT method, the `content-type` header, exposes `ETag`, and has a 3600 s max age.

## Staging

`env.staging` in `wrangler.jsonc` is a second Worker, `bloop-staging`, at `https://bloop-staging.dsap.workers.dev`: its own Durable Object namespaces, D1 `bloop-staging`, EU buckets `bloop-staging-guest` and `bloop-staging-library`, tiny caps, and Cloudflare's published Turnstile test keys as plain vars. Each stream's live checks run there; production gets only the post-deploy smoke.

1. **Resources, once:** `npx wrangler r2 bucket create bloop-staging-guest --jurisdiction eu` and the same for `bloop-staging-library`, then `npx wrangler d1 create bloop-staging --jurisdiction eu`. The D1 goes last: the job skips until it exists and does not look for the buckets, so a missing bucket fails the deploy.
2. **GitHub:** a `staging` environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and a deployment branch rule that allows `staging` only, so no other branch can read the token (the drive's `repo-settings apply` sets it). The token is its own, not the production one: Workers Scripts Edit and D1 Edit on the account, no R2 permission. A token on one account still reaches production's scripts and database there; a separate Cloudflare account for staging is optional and removes that (ADR 0012).
3. **Deploy:** fast-forward the `staging` branch to a commit that is green on its `ci/` branch; nothing else runs the job. Until step 1 and 2 are done the job prints `Staging skipped: ...` and passes.
4. **Secrets:** the job generates every secret that is a random key (`tools/staging.mjs`, listed in `SECRETS`) and pipes it into `wrangler secret put -e staging` when it is missing; none is printed. `ADMIN_EMAILS` and `TEST_EMAILS` are addresses: set them once with `npx wrangler secret put <NAME> -e staging`. Staging sends no email until the mail change adds its admin-only mode.

`STAGING_D1_ID` in the config is a placeholder the job replaces in its own checkout; it is never committed.

## Observability

- `wrangler.jsonc` turns Workers Logs on and invocation logs off, with the sampling rate set there. Invocation logs keep each request's full URL, including `/f/`, `/b/`, `/p/` and invite tokens, for days and possibly outside the EU, so they stay off (threat model SITE-03). Only the Worker's own `log()` lines are kept.
- The Issues toggle is a dashboard step: after the first deploy with this change, open the Worker, Settings, Observability, confirm Logs are on and invocation logs off, turn Issues on, and confirm the next deploy does not reset it.

## Secrets for v4

Names only; never put a value in a file, a commit or a chat. Set each with `npx wrangler secret put <NAME>` (the value is read from a prompt).

| Name | What it is |
|---|---|
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | an R2 API token with Object Read and Write on the two buckets only |
| `R2_ACCOUNT_ID` | the Cloudflare account id; it fills the R2 endpoint in the CSP at serve time, so it never enters the repo |
| `FILE_TOKEN_KEY`, `CODE_PEPPER` | 32 random bytes each, base64url, different from each other and from every older key |
| `FILE_TOKEN_KEY_PREVIOUS` | optional, the same shape; set it only while rotating `FILE_TOKEN_KEY` (below) |
| `TURNSTILE_SECRET_KEY` | the Turnstile widget's secret; the site key is a plain var (`TURNSTILE_SITE_KEY`), not a secret |
| `TALLY_SIGNING_SECRET` | the Tally webhook signing secret; the hook refuses every request until it is set |
| `ADMIN_EMAILS`, `TEST_EMAILS` | comma-separated addresses; entries are normalized (ADR 0013) and an invalid entry is skipped |

To make a key without printing it, pipe it straight in: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | npx wrangler secret put FILE_TOKEN_KEY`. The value goes from the pipe to Cloudflare and is never printed or saved.

To rotate `FILE_TOKEN_KEY` without breaking open previews: put the old value in `FILE_TOKEN_KEY_PREVIOUS`, set a new `FILE_TOKEN_KEY`, deploy, and delete the previous key after the longest preview token life. Tokens are signed with the current key only and verified against the current key, then the previous one.

## Migrations 0004 and 0005 rollout

Every push to `main` applies `migrations/` to production before it deploys (ADR 0012), so this order matters.

1. 0004 (indexes) and 0005 land together, in one push, so rehearse both below first; 0004 is additive and harmless on its own.
2. Rehearse 0005 on a copy of the production database (a `wrangler d1 export bloop --remote` dump, from a Time Travel point, imported into a scratch database): apply 0005 to it, check the new tables and that the `guest_file` rebuild kept every row and recreated 0004's two indexes with the same definitions, and run the retention job against it.
3. Record a Time Travel bookmark immediately before the remote apply: `npx wrangler d1 time-travel info bloop` and note the printed bookmark.
4. 0005 ships in the same commit as the code that needs it: the user-row sweep skips email users, and the erase route hands email users to the purge (ADR 0013). Do not push 0005 without that code.
5. The `guest_file` rebuild copies and swaps the table. A guest insert during it lands before or after the swap, never lost; confirm on the rehearsal copy.

## Restore after a Time Travel restore

A restore brings back users that were purged and sessions that were signed out. After any restore (ADR 0013):

1. List the purge tombstones in the library bucket (the `purged/` prefix) that are newer than the restore point, and run the account purge again for each user.
2. Run `npx wrangler d1 execute bloop --remote --command "DELETE FROM phone_session"`, so every member signs in again.

## Dev mailbox and local test runs

- `DEV_MAILBOX` exposes the codes the Worker would email, at a local route, so tests and local sign-in work with no mail. It is refused when `PUBLIC_ORIGIN` is not a local address; never set it on a deployment.
- Browser tests and local runs use `http://localhost:<port>`, not `127.0.0.1`: WebAuthn refuses IP addresses as a relying-party id. Set `PUBLIC_ORIGIN` in `.dev.vars` to the same `localhost` origin.
- The integration run sets `UPLOAD_MODE=proxy` (the bucket stand-in, no presigned URLs) and `CONVERT_MODE=stub`.
- Every dev server runs with `--enable-containers=false` (also `dev.enable_containers` in `wrangler.jsonc`), so no run needs Docker once the converter container is declared.

## Audit export, retention and the cron jobs

| Name | Kind | Value |
|---|---|---|
| `IT_EXPORT_TOKEN` | secret | at least 32 characters: `openssl rand -base64 32`. Until it is set, `GET /api/it/export` answers 401 to everyone. Give it to IT only; `curl -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/it/export?format=csv&from=2026-01-01&to=2026-01-31"` |
| `AUDIT_RETENTION_DAYS`, `METRICS_RETENTION_DAYS`, `DEMO_RETENTION_DAYS` | var | `180`, `90`, `7` (defaults, pending the legal lane, OD-5) |

The three cron triggers (`*/5 * * * *`, `0 * * * *` hourly, `30 3 * * *` daily) are declared in `wrangler.jsonc` and created by `wrangler deploy`; there is no dashboard step. After the first deploy, check once that the hourly and daily ones fired: Workers dashboard, the Worker, Logs, filter `retention` and `hourly`. The daily line reports the rows it deleted per table. Apply the migrations first: `wrangler d1 migrations apply bloop --remote`.

## Site pages: the contact address and what to renew

Every contact on the public pages is one role address, hi@bloop.here, security reports included: the footer, the legal pages, the articles, `SECURITY.md` and `public/.well-known/security.txt` (RFC 9116). The pages take it from `content/site.json` (`email`; content files write `{{email}}`, and the landing's FAQ line is its `build:ask` region), so only `site.json`, `security.txt` and `SECURITY.md` hold it by hand; a unit test fails on the address typed into a hand page outside its build regions. The Waitlist links open the Tally form `https://tally.so/r/Yj4KAN?source=<page>`. Change them together; `test/unit/build-pages.test.ts` fails on any other @bloop.here address in a published file. Renew `Expires` in `security.txt` at most a year ahead (`test/integration/site.test.ts` fails once it is past or more than about 13 months out).

- **Legal pages:** `/privacy`, `/terms` and `/security` each carry a version. Until the owner declares v1 final, an edit folds into 1.0 and moves its effective date to the deploy day (design.md section 6, Versions); after that, a change gets a new version and effective date in the header block of all three and a line under `#changes`; a material change is emailed to the waitlist first. Privacy's retention table repeats `threat-model.md` section 10, so change both together.
- **Social image:** `og:image` and `og:url` in `public/index.html` name `https://bloop.here` absolutely, as link previews need; change them with the host.
- **Stream mode:** if you set `OPEN_PATH_MODE=stream` (field test T3 below), delete the sentence about the Microsoft download link from "What the PC Holds" (`#pc`) in `public/security.html`.

### Regenerating the site assets
All outputs are committed; run these only when a source changes. Make one throwaway venv with `fonttools` and `brotli` (`python3 -m venv` in a temp directory, then its `pip install fonttools brotli`; inside the Claude Code sandbox set `PIP_USE_DEPRECATED=legacy-certs`). ImageMagick, `avifenc` and `cwebp` come from Homebrew (`imagemagick`, `libavif`, `webp`).

| Change | Command | Writes |
|---|---|---|
| the name, the headline or the logo | edit `SITE_NAME`, `H1` or `SUB` in `tools/render-og.py` (the logo is `public/favicon.svg`), then run it with the venv's python, or with `--font` and a static Inter SemiBold file | `public/og.png`, `public/apple-touch-icon.png`, `tools/og.svg` |
| page text with a new character | the venv's python: `-I tools/subset-font.py`, then `node tools/rehash-immutable.mjs` (the font's name carries its hash) | `public/fonts/inter-latin-<hash>.woff2` |


## Microsoft Entra app registration

Do this once per deployment. It turns on real OneDrive sign-in. Until then bloop runs on the demo account and every `/auth/*` and `/api/me*` route answers `source_unavailable`.

Placeholders below: `<host>` is the deployment's host (for example `bloop.example`), `<client-id>` is the Application (client) ID Entra shows.

### 1. Register the app

In the Microsoft Entra admin center, App registrations, New registration:

- **Name:** `bloop` (users see it on the consent screen).
- **Supported account types:** "Accounts in any organizational directory (Multitenant)". This matches the default `ENTRA_AUTHORITY` (`organizations`). For one organization only, choose "single tenant" and set `ENTRA_AUTHORITY` to `https://login.microsoftonline.com/<tenant-guid>/v2.0`; bloop then accepts only that tenant. Personal Microsoft accounts are not supported by `organizations` (open item, see below).
- **Redirect URI:** platform **Web**, exactly `https://<host>/auth/callback`. Entra compares it as an exact string: no trailing slash, no query, https. The Worker sends `PUBLIC_ORIGIN` plus `/auth/callback`, so `PUBLIC_ORIGIN` must match the origin you register.
- **For local runs against the real tenant** add a second Web redirect URI, `http://localhost:8787/auth/callback`, and run with `PUBLIC_ORIGIN=http://localhost:8787` in `.dev.vars` (Entra accepts http only for `localhost`; the dev server answers on it as well as on 127.0.0.1). Phones on the LAN need https and their own redirect URI (unverified).

### 2. Delegated permissions

API permissions, Add a permission, Microsoft Graph, **Delegated permissions**, exactly:

| Permission | Why |
|---|---|
| `openid` | sign-in and the ID token (`tid`, `oid`) |
| `offline_access` | a refresh token, so the user signs in once (dropped automatically when `TOKEN_MODE=session`) |
| `Files.Read` | read the user's own files, read-only |

Remove the default `User.Read` if you like: bloop does not call `/me`. Add no `.All` permission and no application permission. These three are exactly `ENTRA_SCOPES` (`openid offline_access Files.Read`); the authorize request carries that list and nothing else (threat AUTH-06).

Consent: users can consent to `Files.Read` themselves unless the tenant blocks it. Where it is blocked, the phone shows "Your organization needs to approve bloop." and an admin must grant consent for the tenant ("Grant admin consent" on this page, or the admin consent URL). Whether `Files.Read.Selected` can replace `Files.Read` is unverified (field check F-ENTRA).

### 3. Confidential client secret

Certificates and secrets, New client secret. Copy the **Value** at once (Entra shows it once; the ID is not the secret). Pick an expiry you will remember to rotate (24 months at most). bloop is a confidential client: a stolen refresh token cannot be redeemed without this secret, so rotating it is breach step 1 (ADR 0004).

### 4. Set the configuration

Plain variables go in `wrangler.jsonc` `vars`; secrets are set with `wrangler secret put <NAME>` (locally, put them in `.dev.vars`, which git ignores).

| Name | Kind | Value |
|---|---|---|
| `ENTRA_CLIENT_ID` | var | the Application (client) ID |
| `ENTRA_CLIENT_SECRET` | secret | the secret Value from step 3 |
| `ENTRA_AUTHORITY` | var | leave the default `https://login.microsoftonline.com/organizations/v2.0`, or the single-tenant form above |
| `ENTRA_SCOPES` | var | leave the default `openid offline_access Files.Read` |
| `TOKEN_KEKS` | secret | JSON, `{"k1":"<base64 of 32 random bytes>"}`; make a key with `openssl rand -base64 32` |
| `TOKEN_KEK_CURRENT` | var | the key id to wrap new data keys with, `k1` at first |
| `COOKIE_KEY` | secret | base64 of 32 random bytes, a different one: `openssl rand -base64 32` |
| `HASH_PEPPER` | secret | already required by pairing |
| `TOKEN_MODE` | var | `refresh` (default: sign in once) or `session` (no refresh token is stored; Microsoft's redirect runs at each session start) |
| `GRANT_IDLE_DAYS` | var | `30` (default): a grant unused this long is deleted by the daily job |

`PUBLIC_ORIGIN` must be the registered origin. Every key above must be exactly 32 bytes in standard base64 (44 characters ending in `=`): `config.ts` refuses to start otherwise.

Apply the schema to the production database before the first sign-in: `wrangler d1 migrations apply bloop --remote`.

### 5. Switch `FILE_SOURCE` from mock to graph

1. Set `FILE_SOURCE` to `graph` in `wrangler.jsonc` `vars` (locally, in `.dev.vars`) and deploy (or restart `npm run dev`).
2. If anything in step 4 is missing or malformed, the Worker answers 500 `internal` on every route and logs `config invalid: ...` naming the variable. That is deliberate: it never runs half configured.
3. Check: `GET /api/me` returns `{"source":"graph","signedIn":false,"email":null}`, and `GET /auth/start` redirects (302) to `login.microsoftonline.com`, whose address bar shows `scope=openid offline_access Files.Read`.
4. Sign in on a phone: scan a live screen's code, tap Connect OneDrive, consent, and the file list shows recent `.pptx` and `.pdf` files from the root of the user's OneDrive.
5. To go back, set `FILE_SOURCE` to `mock`. Grants already stored stay (and are deleted when idle); nothing reads them.

Demo screens (`/s?mode=demo`) always use the demo account, with `graph` or `mock`.

### Rotation and revocation

- **Client secret:** create a new secret, `wrangler secret put ENTRA_CLIENT_SECRET`, delete the old one in Entra. Old refresh tokens keep working only for whoever holds the new secret.
- **KEK:** add `"k2"` to `TOKEN_KEKS`, set `TOKEN_KEK_CURRENT` to `k2`, deploy. Each use and the daily job re-wrap data keys. When the daily job reports 0 stale keys, delete `k1`.
- **A user disconnects** from the phone page (Disconnect OneDrive): bloop deletes its stored access. The consent stays in Entra until the user or an admin removes the app (account settings, or Enterprise applications in Entra).

### Open items (need the real tenant, field check F-ENTRA)

- Whether the folder listing works the same for work and personal accounts, and whether `/me/drive/recent` is a better source.
- Whether `Files.Read.Selected` is enough.
- Whether a stolen refresh token really fails after the secret rotates.
- Personal Microsoft accounts need an authority other than `organizations` and a different issuer rule; not supported yet.
- The `email` shown by `/api/me` needs the `profile` scope in `ENTRA_SCOPES`; with the default scopes it may be empty (unverified).


## Field test T3: does PowerPoint open the link

Run this once on a lectern PC (or a PC built like one) before trusting the open path. It answers four questions from ADR 0003: does PowerPoint follow the 302, which HTTP methods it sends, whether it appends a query, and whether the browser needs a click before it will launch PowerPoint. It also covers the PDF view (F-PDF).

You need: a deployed bloop (or a tunnel to `wrangler dev`) with `FILE_SOURCE=graph` and a real OneDrive account, because only Graph gives the redirect something to redirect to (the mock streams in both modes); a phone; the lectern PC with desktop PowerPoint and the browser the room uses (Edge or Chrome); and a terminal on your own machine running `npx wrangler tail --format json` against the deployed Worker. The Worker logs one line per `/f/` request, with no token, address or User-Agent text:

```
{"evt":"open.fetch","method":"GET","client":"office","query":true,"range":false,"status":302}
```

Redirect is the default (`OPEN_PATH_MODE=redirect`). Do the steps in order and write down every answer.

### 1. The launch, and whether a click is needed
1. On the PC, sign in to nothing. Open `https://<host>/s` in the room's browser and leave it alone: do not click the page.
2. On the phone, scan the code, connect OneDrive if asked, pick a small `.pptx`, tap Approve.
3. Watch the PC.
   - **PowerPoint opens by itself, no click:** a click is not needed. Record the browser's own prompt, if any ("Open Microsoft PowerPoint?", with or without "Always allow"). If there was a prompt, answer it, tick Always allow once, and repeat from step 1 to see whether the second run is silent.
   - **Nothing opens and an Open button shows on the screen:** click it. If PowerPoint opens now, a click is needed: the guest flow already supplies one, and the owner flow needs the button. Record that.
   - **Nothing opens and no Open button shows:** the browser had activation but still refused. Use Download It Instead, and record the browser version and any message on the page or in its address bar.

### 2. Does PowerPoint follow the 302
1. In `wrangler tail`, find the `open.fetch` lines for the launch. In redirect mode a working run shows `"status":302` for the GET from the PC, then PowerPoint opens the deck.
2. **Opens, deck is the right file and is current (edit it on the phone's OneDrive beforehand and check the edit is there):** PowerPoint follows the redirect. Redirect stays the default.
3. **A 302 was logged but PowerPoint shows an error, a blank window or Protected View with no content:** it does not follow it. Switch to stream mode (below) and repeat step 1.
4. Record whether the deck opened in Protected View, whether it was read-only (`ofv` should open read-only), and any license or sign-in prompt PowerPoint showed.

### 3. Which methods PowerPoint sends, and whether it appends a query
From the same `wrangler tail`, for one launch, list every `open.fetch` line:
- the methods seen (expected: GET, maybe HEAD first; OPTIONS and PROPFIND would show as `"status":405`, which is the intended answer);
- `"query":true` means Office appended something such as `?OR=ProtocolHandler&CID=...` (the Worker ignores it);
- `"range":true` means it asked for byte ranges (not supported: the Worker answers 200 with the whole file; if PowerPoint then fails, say so);
- how many lines in total. `LINK_MAX_FETCHES` is 10 and the window after the first fetch is 120 s; if one launch used more than about 6, raise the limit.
- `"client"`: `office` means the User-Agent looked like Office. `other` for a GET from the PC means Office sends a User-Agent the Worker does not recognize; note it and keep going.

### 4. The Download fallback and the PDF view
1. Approve again. Before PowerPoint opens, or after closing it without ending the session, use Download It Instead (close PowerPoint's window first, and approve a new session if it already fetched).
2. Click it. The browser should save `<name>.pptx`. Record where it went and whether a download prompt appeared.
3. The screen now says "PowerPoint didn't open." with Show as PDF Instead. Click it. A second window should open and show the PDF with the browser's built-in viewer. **If it is blank, grey, or offers a download instead of showing the PDF, record the browser and version: that is F-PDF failing.** Then check the console of that window for a Content Security Policy message, and try changing `file-pdf` in `src/worker/headers.ts` to plain `default-src 'none'; frame-ancestors 'none'` (or add `object-src 'self'` if it is missing) and redeploy.
4. Click End on the screen. In the browser, open `chrome://version` or `edge://version`, then check the screen tab's Application storage: it should hold no `bloop.*` keys. Try the old PowerPoint link (the browser history keeps none; use a `.url` shortcut or Recent list if PowerPoint made one): it must answer 410.

### Switch to stream mode if the redirect fails
1. Set `OPEN_PATH_MODE` to `stream` in `wrangler.jsonc` `vars` (locally, in `.dev.vars`) and deploy, or restart `npm run dev`. No other change is needed.
2. Repeat step 1 of the launch test. In stream mode the log shows `"status":200` for the GET and the deck bytes pass through the Worker, unstored.
3. Tell whoever writes `/it` and the privacy wording: stream mode changes "bloop keeps no copy" to "passes through, not stored", and it closes the window in which the Graph URL could outlive the session (threat model OPEN-03).

### What to report
Browser and version; Windows and Office build; for each of steps 1 to 4 the observation in bold above; the `open.fetch` lines for one launch; which mode you leave the deployment in.

# Owner setup

Steps only the owner can do, because they need the owner's accounts. Everything else runs locally with `FILE_SOURCE=mock` and needs none of this. How CI and deploy fit together is in [architecture.md](architecture.md) section 12.

## First deploy, in order

1. **Cloudflare account** (free plan), then `npx wrangler login` on your own machine.
2. **D1:** `npx wrangler d1 create bloop --jurisdiction eu`; put the printed id into `wrangler.jsonc` `database_id` (it is all zeros now) and commit it. Then `npx wrangler d1 migrations apply bloop --remote`.
3. **R2:** the bucket and its lifecycle rule, in the next section.
4. **Worker secrets**, each with `npx wrangler secret put <NAME>`: `COOKIE_KEY`, `HASH_PEPPER`, `TOKEN_KEKS` (JSON of key id to base64 key, as in `.dev.vars.example`; `TOKEN_KEK_CURRENT` in `vars` names the current key), `ROOM_ENROLL_KEY`, `IT_EXPORT_TOKEN` (optional; the export stays closed without it), `ENTRA_CLIENT_SECRET` (only with the Entra step). Generate each with `openssl rand -base64 32`; never reuse the `.dev.vars` values.
5. **GitHub:** the owner's settings script holds the repo's settings: features, merge options, a default-branch ruleset (no deletion, no force push, linear history; direct pushes to `main` still work), a tag ruleset, Actions locked to GitHub-owned actions with a read-only token, Dependabot, secret scanning with push protection, private vulnerability reporting, CodeQL, and the `production` environment (`main` only, no required reviewer: a push to `main` deploys once `npm run check` passes in the job). It needs `gh` logged in, so it runs outside the Claude Code sandbox. In order:
   0. Once, in Terminal (interactive): `gh auth refresh -h github.com -s read:user`, so the script can read the account plan.
   1. Plan: shows every difference and writes nothing.
   2. Apply: changes only what differs and prints each change. Lines starting `!` are left for you (visibility, unknown collaborators, keys or hooks, a missing `SECURITY.md`).
   3. Secrets, in Terminal since it prompts with hidden input: asks for `CLOUDFLARE_API_TOKEN` (an account API token, Manage account, Account API tokens, so it is not tied to a person: Workers Editor, D1 Edit and Workers R2 Storage Edit, no IP filter since runner IPs change, 1-year expiry) and `CLOUDFLARE_ACCOUNT_ID` and stores them as `production` environment secrets. Until they exist, the deploy workflow passes and only prints a skip notice.
   4. Check: exits 1 on any drift; rerun it after changing settings by hand.
6. **Placeholders:** replace the addresses and the absolute `og:image` per "Site pages" below.
7. **Address:** the Worker serves at `https://bloop.<account subdomain>.workers.dev` (`PUBLIC_ORIGIN` in `wrangler.jsonc`); a custom domain needs the domain's DNS on Cloudflare (a Workers custom domain), then `PUBLIC_ORIGIN` changes to it in the same commit.
8. **Deploy:** merge or push to `main`; the `production` run deploys after the check passes.

## Checks only a person can do

- **Header grade:** after deploy, `npx @mdn/mdn-http-observatory "$PUBLIC_ORIGIN"` should grade A or better.
- **Browser walk:** allow `127.0.0.1` and `localhost` once in Claude in Chrome, so every page and state can be checked at 1440, 834 and 390 locally. CI's Playwright and axe runs cover the same pages on every push.
- **QR from 2 m:** on a real lectern screen, scan `/s` from the back of the front row with three phones (iPhone camera, Android camera, Android Chrome).
- **Field test T3** on a lectern PC (below), including the PDF view and residue check.
- **Five-person test** (design open item 19): five people who have never seen bloop read the landing for five seconds, then say what it does and what they would do next.
- **Publisher verification** in Entra needs a company (Microsoft Partner Network id); until then, consent screens show "unverified".
- **Privacy roles:** decide controller or processor per buyer type (threat model DATA-01) and have the `/privacy` draft reviewed before the first real user.

## Cloudflare R2 bucket for guest files

Guest uploads (ADR 0005) live in one private R2 bucket in the `eu` jurisdiction. Local runs need none of this: `wrangler dev` emulates the bucket and D1.

1. **Create the bucket** with the name `wrangler.jsonc` binds (`GUEST_FILES`): `npx wrangler r2 bucket create bloop-guest-files --jurisdiction eu`. Leave it private: no public bucket URL, no custom domain, no `r2.dev` subdomain. Objects are read only through the Worker, by key, for a session's `/f/` link.
2. **The 1-day lifecycle rule** is a backstop for the session-end delete and the hourly sweep. Wrangler config cannot express it, so it is a file, `tools/r2-lifecycle.json` (delete objects under `g/` after 86,400 s; abort stale multipart uploads). `deploy.yml` applies it on every deploy, and you can apply it by hand: `npx wrangler r2 bucket lifecycle set bloop-guest-files --file tools/r2-lifecycle.json --jurisdiction eu`. The same rule can be set in the dashboard (R2, the bucket, Settings, Object lifecycle rules: "Delete uploaded objects after 1 day", prefix `g/`). Check it with `npx wrangler r2 bucket lifecycle list bloop-guest-files --jurisdiction eu`: it must show `guest-files-1-day`. The API rejects a rule without a `conditions` block as "not well formed", so the abort rule carries an empty prefix.
3. **The card.** R2 may ask for a payment method before the first bucket, even though the free tier (10 GB stored, a million writes and 10 million reads a month) is far above what guest drops use (unverified: Cloudflare's plan terms change). If you decline, the guest drop cannot run: the documented fallback (guest bytes as chunks in the Screen object, ADR 0005) is not built. Set `GUEST_DROP=off` in `wrangler.jsonc` to refuse drops cleanly until it is, and remove the `r2_buckets` binding only together with that fallback.
4. **The limits** are plain variables in `wrangler.jsonc`: `GUEST_DROP` (`open`, `pass` or `off`), `GUEST_MAX_BYTES` (50 MB; the platform allows at most 100 MB per request body), `DEMO_GUEST_MAX_BYTES`, `DEMO_MAX_CONCURRENT` (demo screens alive at once), `DEMO_MAX_PER_IP` (demo screens one address may hold) and `GUEST_STORAGE_BUDGET_BYTES` (5 GiB of live guest files; above it drops get "bloop can't take files right now."). The `RL_UPLOAD` binding (5 uploads a minute per address) is in the same file.
   **The R2 free-tier hard stop.** R2 is the only product on the account that can bill, and it has no spending cap, so bloop stops itself. It counts its own R2 operations per calendar month (UTC): class A (put, list) against `R2_CLASS_A_MONTHLY_CAP` (default 500,000; free tier 1,000,000) and class B (get, head) against `R2_CLASS_B_MONTHLY_CAP` (default 5,000,000; free tier 10,000,000), each at 50% of the free tier because the billing period may not align with calendar months and any 30 days span two; a single delete is free and not counted (the sweep's bulk delete counts as one class A). At a cap, drops get "bloop can't take files right now." and `/f/` reads of guest files fail with `upstream_failed`, until the month rolls over. Storage (10 GB free) is held by `GUEST_STORAGE_BUDGET_BYTES` (5 GiB). Read the counters with `npx wrangler d1 execute bloop --remote --command "select month, class, n from r2_ops order by month desc, class"`. The counts are bloop's own: operations outside the Worker are not metered. Each deploy's `lifecycle set` is one class A, the lifecycle rule's own deletes are Cloudflare's, and browsing the bucket in the dashboard lists and reads, so do not browse it. The other half of the free tier is the headroom for these. Turn on a Cloudflare billing notification (dashboard, Billing, Notifications) as a second warning.
5. **After the first deploy**, run `wrangler tail`, send a file from a phone through a live screen, open it, End the session, and confirm the object is gone: `npx wrangler r2 object get bloop-guest-files/<key> --remote --jurisdiction eu` should fail with "not found". The key is in the D1 `guest_file` row (`wrangler d1 execute bloop --remote --command "select r2_key, deleted_at from guest_file order by created_at desc limit 1"`).

## Audit export, retention and the cron jobs

| Name | Kind | Value |
|---|---|---|
| `IT_EXPORT_TOKEN` | secret | at least 32 characters: `openssl rand -base64 32`. Until it is set, `GET /api/it/export` answers 401 to everyone. Give it to IT only; `curl -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/it/export?format=csv&from=2026-01-01&to=2026-01-31"` |
| `AUDIT_RETENTION_DAYS`, `METRICS_RETENTION_DAYS`, `DEMO_RETENTION_DAYS` | var | `180`, `90`, `7` (defaults, pending the legal lane, OD-5) |

The two cron triggers (`0 * * * *` hourly, `30 3 * * *` daily) are declared in `wrangler.jsonc` and created by `wrangler deploy`; there is no dashboard step. After the first deploy, check once that both fired: Workers dashboard, the Worker, Logs, filter `retention` and `hourly`. The daily line reports the rows it deleted per table. Apply the migrations first: `wrangler d1 migrations apply bloop --remote`.

## Site pages: the contact address and what to renew

Every contact on the public pages is one role address, ventures@saputra.co.uk: the Waitlist mail, the footer, the privacy notice and `public/.well-known/security.txt` (RFC 9116). Change them together; `test/unit/site-pages.test.ts` fails on any other address. Renew `Expires` in `security.txt` at most a year ahead (`test/integration/site.test.ts` fails once it is past or more than about 13 months out).

- **Privacy notice:** `/privacy` is a draft (it says so on the page and is `noindex`). The legal lane (OD-5) confirms roles, lawful bases and the retention periods it lists before launch; it repeats `threat-model.md` section 10, so change both together.
- **Social image:** `og:image` and `og:url` in `public/index.html` name the host absolutely, as link previews need; change them with the host.
- **Stream mode:** if you set `OPEN_PATH_MODE=stream` (field test T3 below), delete the sentence about the Microsoft download link from the "What the PC holds" row of `public/security.html` and design.md.

### Regenerating the site assets
All outputs are committed; run these only when a source changes. Make one throwaway venv with `fonttools` and `brotli` (`python3 -m venv` in a temp directory, then its `pip install fonttools brotli`; inside the Claude Code sandbox set `PIP_USE_DEPRECATED=legacy-certs`). ImageMagick, `avifenc` and `cwebp` come from Homebrew (`imagemagick`, `libavif`, `webp`).

| Change | Command | Writes |
|---|---|---|
| the name, the headline or the logo | edit `SITE_NAME`, `H1` or `SUB` in `tools/render-og.py` (the logo is `public/favicon.svg`), then run it with the venv's python, or with `--font` and a static Inter SemiBold file | `public/og.png`, `public/apple-touch-icon.png`, `tools/og.svg` |
| page text with a new character | the venv's python: `-I tools/subset-font.py` | `public/fonts/inter-latin.woff2` |


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
   - **Nothing opens and no Open button shows:** the browser had activation but still refused. Wait 5 s for Download It Instead, and record the browser version and any message on the page or in its address bar.

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
1. Approve again. Before PowerPoint opens, or after closing it without ending the session, wait for Download It Instead (5 s after the launch with no fetch, so close PowerPoint's window first and approve a new session if it already fetched).
2. Click it. The browser should save `<name>.pptx`. Record where it went and whether a download prompt appeared.
3. The screen now says "PowerPoint didn't open." with Show as PDF Instead. Click it. A second window should open and show the PDF with the browser's built-in viewer. **If it is blank, grey, or offers a download instead of showing the PDF, record the browser and version: that is F-PDF failing.** Then check the console of that window for a Content Security Policy message, and try changing `file-pdf` in `src/worker/headers.ts` to plain `default-src 'none'; frame-ancestors 'none'` (or add `object-src 'self'` if it is missing) and redeploy.
4. Click End on the screen. In the browser, open `chrome://version` or `edge://version`, then check the screen tab's Application storage: it should hold no `bloop.*` keys. Try the old PowerPoint link (the browser history keeps none; use a `.url` shortcut or Recent list if PowerPoint made one): it must answer 410.

### Switch to stream mode if the redirect fails
1. Set `OPEN_PATH_MODE` to `stream` in `wrangler.jsonc` `vars` (locally, in `.dev.vars`) and deploy, or restart `npm run dev`. No other change is needed.
2. Repeat step 1 of the launch test. In stream mode the log shows `"status":200` for the GET and the deck bytes pass through the Worker, unstored.
3. Tell whoever writes `/it` and the privacy wording: stream mode changes "bloop keeps no copy" to "passes through, not stored", and it closes the window in which the Graph URL could outlive the session (threat model OPEN-03).

### What to report
Browser and version; Windows and Office build; for each of steps 1 to 4 the observation in bold above; the `open.fetch` lines for one launch; which mode you leave the deployment in.

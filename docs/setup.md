# Owner setup

Steps only the owner can do, because they need the owner's accounts. Everything else runs locally with `FILE_SOURCE=mock` and needs none of this. The Cloudflare steps (account, D1, R2, DNS) are in [architecture.md](architecture.md) section 12.

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

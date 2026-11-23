# bloop threat model

Status: draft for review. Method: STRIDE per seam. Design references: [architecture.md](architecture.md) and [interfaces.md](interfaces.md).

How to read a row: L is likelihood and I is impact (each low, med or high). Status is one of:
- **mitigated**: mitigated in design, and the named test proves it;
- **residual**: a mitigation exists, but some risk is accepted, as stated;
- **open**: it waits on a field test or an owner decision (OD, section 11).

Every test id is the title prefix of a test in `test/`, and CI fails when a mitigated row has no test.

Assets, in order of value:
1. Refresh tokens that can read whole OneDrives.
2. The user's chosen file.
3. The right to put content on a room screen.
4. Audit data: who, where, when, and the file name.
5. Guest uploads.
6. Service availability.

Trust boundaries:
- phone browser and Worker;
- screen browser and Worker;
- PowerPoint and `/f/`;
- Worker and Microsoft;
- Worker and storage (D1, R2, DO);
- the Cloudflare account itself.

## 1. Auth and token store (DPIA item first)
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| AUTH-01 | I | **One breach exposes every connected OneDrive.** bloop holds a refresh token per user, and `Files.Read` reads the whole drive. An attacker with D1 contents and the Worker secrets can read every user's files. | low | high | (1) Envelope encryption: a per-user AES-256-GCM key, wrapped by a KEK held as a Worker secret, so a leak of D1 alone (export, backup, query bug) yields ciphertext. (2) A confidential client: a stolen refresh token cannot be redeemed without the Entra client secret, so breach step 1 is rotating that secret, which strands every stolen token. (3) Grants unused for 30 days are deleted (Microsoft keeps them 90). (4) Least scope. Read-only. No access token outlives 1 h. (5) `TOKEN_MODE=session` stores no refresh token at all (ADR 0004). (6) Published breach plan. Limit: a compromise of the Cloudflare account or a deploy holds both ciphertext and key; envelope encryption does not defend that. | `AUTH-01 vault`: ciphertext holds no plaintext, a row copied to another user fails to decrypt (AAD), and KEK rotation re-wraps. `AUTH-01 drill` (field, demo tenant): after the client secret rotates, redeeming an old refresh token fails | **residual; OD-1** |
| AUTH-02 | T | A refresh-token race: two requests refresh at once and the slower one overwrites the newer token with a stale one | med | med | `UPDATE ... WHERE version = ?` compare-and-swap; the loser re-reads | `AUTH-02 cas` (concurrent refreshes against a real SQLite database) | mitigated |
| AUTH-03 | S | Login CSRF or code injection on `/auth/callback` | med | med | `state`, PKCE S256 and `nonce` in an AEAD cookie (10 min, SameSite=Lax), checked by oauth4webapi; callback is GET only; there is no return URL to tamper with | `AUTH-03 state` (wrong or missing state gives 400 and sets no cookie) | mitigated |
| AUTH-04 | S | Multi-tenant issuer confusion: a token from tenant A accepted as tenant B, or users keyed by a mutable email | low | high | Check that `iss` equals `https://login.microsoftonline.com/{tid}/v2.0` with `tid` from the token; key users by `(tid, oid)`, never by email | `AUTH-04 iss` (crafted claims) | mitigated (R1 open question 3 confirms on a real tenant) |
| AUTH-05 | I | Phone session cookie stolen (XSS, malware, a shared phone) | low | high | `__Host-`, HttpOnly, Secure, SameSite=Lax; only its hash is stored; 30 days idle, 90 absolute; strict CSP and Trusted Types (SITE-02); `/me` disconnect; an admin can revoke in Entra | `AUTH-05 cookie` (attributes, hash at rest) | residual (a stolen unlocked phone is out of scope) |
| AUTH-06 | E | Scope wider than the need: `Files.Read` grants the whole drive, and "reads one folder" cannot be checked by IT | high | med | Read-only scope, no `.All`; listing limited to decks; every read audited; say it plainly on `/it`; evaluate `Files.Read.Selected` and the app folder (unverified) | `AUTH-06 scope` (authorize URL holds exactly `ENTRA_SCOPES`) | residual; OD-1 |
| AUTH-07 | R | Revocation overclaim: disconnect deletes bloop's tokens, but the Entra consent stays | med | low | `/me` and `/it` say how to remove the app in Entra or account settings | `AUTH-07 copy` (string present), `AUTH-07 disconnect` (grant and every session deleted) | mitigated |

## 2. Pairing
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| PAIR-01 | S | Replay of a code | med | med | The Screen object marks the code consumed in the same single-threaded step that claims it; codes die 70 s after issue. The Directory keeps a claimed or expired code for 5 min on purpose, so a replay or a late phone reaches the Screen object and gets `code_taken` or `code_expired` (and no miss is counted against it) | `PAIR-01 replay` (second claim gives `code_taken`; claim at 71 s gives `code_expired`) | mitigated |
| PAIR-02 | S | A code photographed or shoulder-surfed and used within 60 s, from the back of the room or a hallway | med | med | The first claim wins and locks the pairing to that phone, and the real presenter's phone shows "This code was already used." The screen shows "Check your phone. It should show 42", so a presenter whose phone shows nothing knows someone else holds it. A "Start Over" control on the screen (decided, OD-6) drops an unapproved claim in one click; unattended claims time out after 5 min. What the attacker can do: approve their own file onto that screen (unwanted content, audited with their identity, or a guest drop that still waits for the Open click) or block the start for a while. They cannot read the presenter's files. | `PAIR-02 race` (two phones, one code: second gets `taken`; restart frees the screen) | residual; OD-2, OD-6 |
| PAIR-03 | S | **Phishing or relay screen.** An attacker shows a real bloop QR from a screen they control (a fake lectern page, a poster, a sticker over the real QR, a cloned room page), so a victim approves a file onto the attacker's screen | med | high | (1) Registered rooms: the phone shows the room's registered name only when the screen holds that room's key (ADR 0008). (2) Every other screen is labeled "This screen isn't registered. Only approve if you can see it in front of you." (3) The match code exposes stickers and posters: the victim's phone shows 42, the real screen shows no match (PAIR-04). (4) The prize is one file the victim picked, with a link that dies at session end; never the account or other files. (5) Audit shows where the file went. Limit: on an unregistered screen, a victim who ignores the warning hands over one file. | `PAIR-03 label` (unregistered screen gives the warning state; a registered one gives the name; a room cookie from room A cannot claim room B's name) | **residual; OD-3** |
| PAIR-04 | S | Overtrusting the 2-digit match code | med | med | Be honest about it. It is 1 in 100, random per pairing. **It defends:** scanning the wrong screen, and a sticker or poster QR placed over a real screen (the real screen shows no match, or a different number 99% of the time). **It does not defend:** a live relay, an attacker who controls the screen the victim is looking at, or brute force; it is a check for a human, not a secret. The copy calls it a check that you have the right screen, never a security code. | `PAIR-04 match` (uniform over 00 to 99; drawn fresh per claim) | residual (by design) |
| PAIR-05 | S, E | Approving from a second phone | med | high | The claim returns a 256-bit pairing secret to the first phone only (pid in `sessionStorage`). Approve, upload, cancel and end need it. A second claim on the same code gets `code_taken` | `PAIR-05 second-phone` | mitigated |
| PAIR-06 | T | CSRF on approve, end, cancel, drop or restart | med | high | No ambient authority: pid and sid travel in `Authorization` from `sessionStorage`, which a cross-site page cannot read. The Origin header must equal `PUBLIC_ORIGIN`. `Sec-Fetch-Site` must be same-origin when present. `application/json` is required (a simple form post gets 415). Cookies are SameSite=Lax | `PAIR-06 csrf` (cross-origin, form-encoded and missing-auth requests refused) | mitigated |
| PAIR-07 | I, D | Guessing or enumerating typed codes | med | med | 30^6 is about 7.3e8 codes. Each IP hash gets 10 misses per 10 min, counted exactly in the Directory. Each IP gets 20 claims per min (binding). A global alarm logs one `pair.miss_alarm` line at 1,000 misses per 10 min (it blocks nobody). Arithmetic: 1,000 live codes against 100,000 guesses per 10 min from a botnet gives about 0.14 hits per 10 min. A hit only claims a random screen (PAIR-02 impact). Escalation: `CODE_LENGTH=7` (2.2e10) | `PAIR-07 limits` (11th miss gives 429; window resets; the 1,000th miss across hashes logs the alarm) | residual |
| PAIR-08 | I | Guessing sid, pid or session ids | low | high | 128-bit refs plus 256-bit secrets from `crypto.getRandomValues`; only hashes are stored; comparisons are constant-time | `PAIR-08 ids` (format, length, hash at rest) | mitigated |
| PAIR-09 | D | Flooding screen creation or code requests until the free tier fails | med | med | Bindings on `/api/screens` and `/api/claim`, and per session on `/api/files` (a Graph call each); 6 codes per min per screen; hidden tabs stop asking for codes; over the cap the status line shows "bloop isn't responding. Sign in to this PC as usual." | `PAIR-09 flood` | residual (free-tier caps; OD-7) |
| PAIR-10 | S | Cross-site WebSocket hijacking | low | med | Upgrade refused unless `Origin` matches; auth is the first message, not a cookie | `PAIR-10 ws-origin` | mitigated |
| PAIR-11 | T | A tampered screen sends false events (`launched`, `fallback`) | med | low | Events change metrics and UI only; a screen cannot list files, choose a file or mint a link for any file but the approved one; fallback mints are capped at 5 | `PAIR-11 screen-events` | mitigated |

## 3. File source
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| SRC-01 | I | The screen learns more than the chosen file (the file list, the account) | low | med | The file list goes to the phone only; `ScreenView` carries the chosen file's name, type and size alone; no Graph id or URL ever reaches the screen | `SRC-01 screen-view` (schema rejects extra keys; socket capture) | mitigated |
| SRC-02 | E | Approving a file id not offered (IDOR), or another user's file | low | high | The Screen object stores the listed ids and approve must match one; resolve runs with the approving user's own token, so Graph enforces ownership | `SRC-02 idor` | mitigated |
| SRC-03 | D | Graph throttling or outage | med | med | Map 429 and 503 to `source_throttled`; phone "Unable to open your slides."; the screen keeps its fallback line | `SRC-03 errors` (mock injects 429) | residual |
| SRC-04 | T | The mock source serves in production, or demo reaches Graph | low | high | The source is fixed per screen at creation from `mode` and `FILE_SOURCE`; `config.ts` refuses `graph` without Entra settings; demo code paths never construct `GraphFileSource` (ADR 0007) | `SRC-04 isolation` | mitigated |
| SRC-05 | E | A macro deck from the user's own drive | low | med | Listing excludes `.pptm`, `.ppsm` and `.potm`; `ofv` opens read-only; Office's Mark of the Web blocks macros in downloaded files | `SRC-05 filter` | mitigated |

## 4. Open path
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| OPEN-01 | I | `/f/` link leaks: Office writes the URL into a `.url` shortcut and recent lists, some builds append `?OR=ProtocolHandler&CID=...`, and the download list keeps it | high | med | The link dies at session end. It dies 10 min after mint if unused, and 2 min after first fetch. It allows at most 10 fetches. The query is ignored. `no-store`. Only the token hash is stored. A leaked link is dead long before the next user sits down | `OPEN-01 link-life` (after end gives 410; after window gives 410; with `?OR=` inside the window gives 200) | mitigated (dead links stay in lists: RES-02) |
| OPEN-02 | S | Someone other than this PC fetches a live link. Binding is hard because PowerPoint, not the browser, fetches it: no cookie, no header we control | med | med | Short life (OPEN-01), plus soft IP binding. The screen's IP hash is recorded on the socket and compared on each fetch. `log` (default) audits a mismatch; `enforce` refuses it per room. Default is log because the browser and Office can leave through different proxies | `OPEN-02 binding` (enforce mismatch gives 403; log mismatch gives 200 plus an audit flag) | **open; OD-4, T3** |
| OPEN-03 | I | Redirect mode hands PowerPoint the Graph pre-authenticated URL, which bloop cannot revoke and which may live up to 1 h; it may land in Office's caches and lists | med | med | The URL is resolved only at fetch time; it never reaches the browser; `/it` states this; `OPEN_PATH_MODE=stream` keeps Graph URLs on the server, at the cost of carrying the bytes | field T3 and T20 (does the Graph URL persist on the PC?) | **open; T3, T20** |
| OPEN-04 | T | Open redirect through `/f/` or `/auth/*` | low | med | `/f/` redirects only to a URL from Graph whose host matches `GRAPH_DOWNLOAD_HOSTS`, else 502; no route accepts a return URL; `/auth/callback` always goes to `/a` | `OPEN-04 redirect` (resolver returns an evil host and gets 502) | mitigated |
| OPEN-05 | I | Tokens leak by Referer | low | med | `Referrer-Policy: no-referrer` on every response; `/f/` is fetched by Office, not by a page | `OPEN-05 headers` | mitigated |
| OPEN-06 | T | A file name breaks the URI syntax (a `|` splits `ofv|u|`, `..` into the `.url` name) | med | med | `public/js/shared/names.js` reduces the name to an ASCII slug (`[A-Za-z0-9-]`, accents folded, everything else a hyphen, so none of `\ / : ? < > | " * % #`, control characters or `..` can survive and nothing is percent-encoded); caps it at 60 characters and so the whole link at 200 for the configured origin; forces the extension. The name segment is cosmetic: the server ignores it | `OPEN-06 names` (fast-check: output matches the safe pattern; the longest possible name keeps the link under 200 and the Office URI under 256 characters) | mitigated |
| OPEN-07 | E | Office tries a WebDAV write-back (OPTIONS, PROPFIND, PUT) | low | low | 405 with `Allow: GET, HEAD`; `ofv` is read-only | `OPEN-07 methods` | mitigated |
| OPEN-08 | E | Script runs from a served file in bloop's origin (an HTML or SVG polyglot, a PDF with script) | low | high | `nosniff`; Content-Type from detected type only; `.pptx` gets `attachment` with `sandbox` CSP; the PDF view gets `default-src 'none'; object-src 'self'`; CORP same-origin. Whether Chromium renders a PDF under `sandbox`, and whether `object-src 'self'` is what its viewer needs, are unverified | `OPEN-08 served-headers`; field: PDF view on the lectern browser with the final CSP | open (field) |

## 5. Guest drop
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| DROP-01 | D | Oversized upload | med | med | `Content-Length` required and at most `GUEST_MAX_BYTES` before any read; a counting stream aborts at the cap; the platform caps bodies at 100 MB | `DROP-01 size` | mitigated |
| DROP-02 | T | Wrong type or a polyglot (PDF plus ZIP, HTML in a deck) | med | high | Magic bytes; a `.pptx` must start with `PK\x03\x04`, have no `%PDF` in the head, and hold the required parts; a `.pdf` must start with `%PDF-` and have no ZIP end record in its tail; extension and detection must agree; served type comes from detection | `DROP-02 polyglot` (fixture corpus) | mitigated |
| DROP-03 | E | Active content in a deck (VBA, ActiveX, OLE packages) | med | high | Refuse `vbaProject.bin`, `activeX/`, any `.bin` part and macro content types; the PC opens it under Mark of the Web and Protected View. This may refuse some legitimate decks with OLE embeds; the refusal rate is measured | `DROP-03 macro` | mitigated (refusal rate unmeasured) |
| DROP-04 | D | Zip bomb, aimed at the server or at PowerPoint on the PC | low | med | The server decompresses one part only: `[Content_Types].xml`, capped at 256 KiB, and the upload is never inflated as a whole. Central-directory caps: 5,000 entries, 1 GiB declared, 200:1 per entry from 64 KiB up (smaller parts legitimately compress further), no Zip64. Declared sizes can lie, so the PC's PowerPoint could still stall: the damage stays on one screen for one session | `DROP-04 bomb` (declared total, ratio, zero-compressed, entry count at and over 5,000, content-types cap) | residual |
| DROP-05 | D | Storage exhaustion | med | med | One file per session; sessions last at most 90 min; a live-bytes budget (`GUEST_STORAGE_BUDGET_BYTES`, reserved in one D1 statement before any byte is stored) gives `storage_full`; per-IP binding (5 uploads a minute); demo cap 10 MB; 1-day lifecycle rule | `DROP-05 budget`, `DROP-05 one file per session`, `DROP-05 demo cap`, `DROP-05 rate` | mitigated |
| DROP-10 | D | Cost abuse: uploads and reads push R2 past its free tier, and R2 has no spending cap | low | med | Every R2 put, list, get and head is counted in D1 per UTC month before it runs (`r2_ops`); at 50% of the free tier per calendar month (`R2_CLASS_A_MONTHLY_CAP` 500,000, `R2_CLASS_B_MONTHLY_CAP` 5,000,000; the billing period may not be the calendar month, and any 30 days span two) drops get `storage_full` and `/f/` guest reads get `upstream_failed`; a counter write failure refuses the operation; single deletes are free and still run, bulk deletes are counted as class A; the stored-bytes budget covers the 10 GB. A Cloudflare billing notification is the second warning | `DROP-05 R2 cap` (integration: counted drop, class A cap, class B cap on a new drop and on `/f/`, reads passing the cap mid-upload), `R2 cap` (unit: meter, month rollover, purge and sweep at the cap, fail closed, 13-month retention) | mitigated |
| DROP-06 | S, T | **Unwanted content pushed onto a room screen** by anyone who can scan it | med | high | A guest file never opens by itself: the screen shows its name with an "Open" button, and only a click on the screen opens it, which proves someone is at the lectern. The code lives 60 s, and the first phone to claim it locks the pairing. Every drop is audited with the claim's IP hash. Optional per room: `pass`, a host-issued guest link (24 h, one session) that IT can require; audited with the pass's host | `DROP-06 open-click` (a valid upload stays `offered` and no link is minted until `open.click`; an unclicked offer expires and the object is deleted), `DROP-06 policy` (a `pass` room without a pass gives `pass_required`; used pass refused) | mitigated in design |
| DROP-07 | I | Deletion fails and a guest file outlives its session | low | med | Three layers: deletion at end; an hourly sweep of objects older than 2 h; the R2 lifecycle rule at 1 day; plus a D1 `guest_file.deleted_at` check | `DROP-07 sweep` (the sweep deletes old objects and closes old rows, against a fake bucket), `DROP-07 purge` (a failed delete leaves the row for the sweep), `DROP-07 deletion at the end of a session` and `DROP-07 auto-end` (the object is gone from R2 after End, Cancel, Start Over, an expired offer and the session limit), `DROP-07 audit of the delete`; `deploy.yml` applies the lifecycle rule from `tools/r2-lifecycle.json` (unverified on the real account, F-CF) | mitigated |
| DROP-08 | I | Script injection through a file name | med | high | `textContent` only; Trusted Types `'none'`; sanitized and capped names | `DROP-08 xss` (name `<img onerror>` renders as text) | mitigated |
| DROP-09 | I | A guest file read by someone else | low | med | Random R2 key; a private bucket with no public domain; served only through the session's `/f/` link | `DROP-09 access` | mitigated |

## 6. Residue
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| RES-01 | I | The screen browser keeps something after end | med | med | Only `bloop.sid` sits in `sessionStorage`, and links are in memory; `ScreenResidue.clear()`; `Clear-Site-Data: "storage"` on end; `history.replaceState` | `RES-01 storage` (Playwright: after end, storage holds only the fresh sid) | mitigated (browser side) |
| RES-02 | I | Copies outside the browser's reach: Downloads, Office recent lists, caches, jump lists | high | med | Nothing a web page can do. `/it` and the FAQ say a copy can stay; each room is audited after end, sign-out and reboot; the claim is made per room only | field T20 | **open; T20** |
| RES-03 | I | Server keeps session data past its need | low | med | `ServerResidue.purge` drops links, pairing secrets, listed ids and the guest object; `deleteAll()` at close; D1 keeps only audit and metrics, under section 10's retention (audit rows hold no file contents, token, URL, code or IP; metric rows hold no user or file name) | `RES-03 purge` (storage dump after end), `DATA-04 content`, `metric_event` has no user column (unit) | mitigated |
| RES-04 | I | A PDF window or tab left open after end | med | low | The screen keeps the window reference and closes it on end; links die anyway | `RES-04 pdf-window` | mitigated |

## 7. Site
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| SITE-01 | T | Framing `/a` to clickjack Approve | med | high | `frame-ancestors 'none'` and `X-Frame-Options: DENY` everywhere; `/a` also renders the "framed" state when `top !== self` | `SITE-01 frame` (Playwright iframe gets blocked) | mitigated |
| SITE-02 | T | XSS on any page | low | high | CSP with no inline script, `require-trusted-types-for 'script'` with `trusted-types 'none'`, no HTML string sinks (Biome rule plus a grep), textContent only | `SITE-02 csp` (csp_evaluator; no CSP or Trusted Types reports in e2e) | mitigated |
| SITE-03 | I | Logs leak tokens, codes, IPs or file names | med | high | One `log()` with a fixed shape (route pattern, status, code, ms); Workers Logs keeps 3 days | `SITE-03 logs` (grep the captured integration log for every secret it used) | mitigated |
| SITE-04 | D | The free tier runs out: calls fail, they are not billed | med | med | Rate limits; the status line within 5 s; bloop is never the only route; Workers Paid lifts the caps | `SITE-04 status` (health failure shows the service-down state) | residual; OD-7 |
| SITE-05 | T | Supply chain | low | high | Two runtime packages plus vendored `uqr`, pinned by hash; `npm ci` from the lockfile; a scoped deploy token in a reviewed environment | `SITE-05 deps` (runtime dependency list equals ADR 0001's) | residual |
| SITE-06 | T | CSV formula injection in the IT export | med | med | Cells starting with `= + - @`, tab or CR get a leading `'`; JSON is the safe default | `SITE-06 csv` (unit: every leading character, quoting, the metrics file; integration: a guest file named `=HYPERLINK(1).pptx` reaches the CSV as `'=HYPERLINK(1).pptx`) | mitigated |
| SITE-07 | E | IT export misuse: one shared bearer token | low | high | A 256-bit token compared as a hash in constant time, closed (401) while `IT_EXPORT_TOKEN` is unset, rate-limited per pseudonymous IP before the token check (a limit keyed by the token would not slow guessing), every run audited as `export.run` before any data is sent; later Entra app roles per org | `SITE-07 export-auth` (401 for none, wrong and short tokens, and for any token when unset; 429 past `RL_EXPORT`; the run row; strict headers and `no-store`; bad range 400) | residual (single token until org roles) |
| SITE-08 | S | Downgrade or cookie theft on the wire | low | high | HSTS 2 years; `__Host-` cookies; `upgrade-insecure-requests` | `SITE-08 headers` | mitigated |

### Demo (ADR 0007)
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| DEMO-01 | E | The public demo reaches a real account, the vault or Graph | low | high | Mode is fixed at creation; the demo claim, listing and approval never read the session cookie and use the bundled demo account; the session and audit rows carry no user. The demo screen launches nothing and shows the file in the page from its own state; its one-device round trip (`/s?mode=demo` to `/a` and back in one tab) resumes the screen only through the sid in that tab's `sessionStorage`, and only a screen of the page's mode, so no other tab or browser can pick a screen up | `DEMO-01 flow` (a full demo run with a forged account cookie ignored; e2e: the slides in the page with no launch, the guest file card), `DEMO-01 reload`, `DEMO-01 isolation`, `DEMO-01 round trip` (e2e) | mitigated |
| DEMO-02 | D | Flooding demo creation or claims, or filling the demo cap, to starve visitors or the free tier | med | low | Per-IP bindings for demo creations and claims (`RL_DEMO_CREATE`, `RL_DEMO_CLAIM`), sized so a room on one Wi-Fi can try it; a global cap on concurrent demo screens in the Directory and a cap per IP hash (`DEMO_MAX_PER_IP`), each slot lapsing after a claim window plus one session or freed when the session ends; demo drops capped at 10 MB and deleted at session end (DROP-05) | `DEMO-02 flood`, `DEMO-02 cap`, `DEMO-02 per-ip` (integration, unit) | residual (the per-IP cap divides the global one, so about 9 addresses can fill every demo slot for about a quarter hour, and an IPv6 /64 holds many addresses; visitors behind a shared address share its per-IP cap; the live product is unaffected) |
| DEMO-03 | T | The demo cannot be turned off in an incident | low | med | `DEMO_ENABLED=false` refuses every demo create and every claim of a demo code with `not_found`; `/s?mode=demo` still serves, shows "bloop isn't responding." and retries | `DEMO-03 off` | mitigated |
| DEMO-04 | R, I | Demo records mix into product numbers or outlive their purpose | low | low | Sessions, audit rows and metrics are `mode = demo`; retention is `DEMO_RETENTION_DAYS` (7) | `DEMO-04 records`, `DATA-02 retention` | mitigated |

## 8. Data and UK GDPR
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| DATA-01 | R | Roles unclear: who is controller for staff data, guest uploads and audit | high | high | Proposed: with no customer contract, bloop is controller for its users and for guest uploads. Under a university agreement, bloop is processor for staff use and for guest uploads on the university's rooms, with a DPA. Demo: controller, holding no personal data beyond a transient IP hash. Lawful basis per activity; privacy notice; ROPA | none (legal) | **open; OD-5** |
| DATA-02 | I | Data kept too long | med | med | Retention table in section 10, run by the daily cron; periods are config | `DATA-02 retention` (unit, with the clock passed in: audit and demo rows, metrics rolled into daily counts, guest rows, passes, idle grants, user rows, the hourly closer for session rows that lost their end, idempotent second run; config defaults) | mitigated (periods need OD-5; the cron trigger itself is untested locally) |
| DATA-03 | I | Transfer: Cloudflare is US-owned, Workers run at the nearest edge, DO ids are logged outside the EU | high | med | Claim "stored in the EU", never "UK only" or "never leaves"; DPA with SCCs and the UK Addendum; the Node exit (ADR 0001) for a buyer who needs it | none (claim review) | residual |
| DATA-04 | I | File names in audit reveal sensitive matters | med | med | 180-day default; the user sees their own rows; erasure removes the user id and file name | `DATA-04 erase` (store: user id and file name gone from the session row and the audit detail, other users untouched; `DATA-04 content`: detail keys outside the allowed set are dropped before the write; the `DELETE /api/me` route is not built) | residual |
| DATA-05 | R | Subject access and erasure | med | med | `/api/me/audit`, `DELETE /api/me`, the export | `DATA-05 dsar` (store: a user reads only their own rows, newest first, with a cursor; routes: `/api/me/audit` needs a session and never shows another user's rows; `DELETE /api/me` erases, records `user.erased` and leaves no link back) | mitigated (`pass.created` waits for guest passes) |

## 9. Malicious lectern PC
| id | STRIDE | threat | L | I | mitigation | test | status |
|---|---|---|---|---|---|---|---|
| PC-01 | I | Malware on the PC copies the deck | med | med | Inherent to presenting on any PC, USB stick included; it gets one file, never the account or another file; nothing is typed at the PC | none (by design) | residual (accepted) |
| PC-02 | I, E | Malware takes the sid or a live link | med | med | A sid cannot list files, choose files or mint links beyond the approved file (5 mints, audited); links die at end; the phone's End revokes everything server-side; the 90-min end does not depend on the screen | `PC-02 sid-powers` | mitigated |
| PC-03 | S | A rogue page on the PC socially engineers extra approvals ("PowerPoint failed, approve again") | low | med | Each approval names one file and the room; every approval is audited; there is no "approve again" in the flow, because fallbacks reuse the approval | `PC-03 single-approval` | residual |
| PC-04 | T | The PC keeps the session alive | low | med | The alarm ends the session server-side at 90 min; the hourly cron is the backstop | `PC-04 auto-end` | mitigated |

## 10. Retention (DATA-02)
| data | where | kept |
|---|---|---|
| pairing state, links, codes | Screen DO | until end, cancel or timeout |
| guest file bytes | R2 | until session end; sweep at 2 h; lifecycle 1 day |
| guest file row | D1 | 30 days after deletion |
| R2 operation counters (`r2_ops`) | D1 | 13 months |
| session and audit rows | D1 | 180 days (`AUDIT_RETENTION_DAYS`); demo 7 days |
| metric events | D1 | 90 days, then daily counts for 2 years |
| weekly-active pseudonyms | D1 | 120 days |
| refresh token (grant) | D1 | until disconnect, erasure, or 30 days unused |
| phone session | D1 | 30 days idle, 90 absolute |
| guest pass | D1 | 24 h |
| user row | D1 | while a grant or session exists, then 30 days |
| Worker logs | Cloudflare | 3 days, no personal data |
| failed-lookup counters | Directory DO | 10 min |

## 11. Owner decisions and field tests
| id | decision or test | recommendation |
|---|---|---|
| OD-1 | Token mode: `refresh` (sign in once; holds refresh tokens) or `session` (no stored refresh token; a Microsoft redirect each session, often silent). Also the idle limit | `refresh` with 30-day idle for the MVP; switch to `session` if a customer DPIA asks; keep both behind `TOKEN_MODE` |
| OD-2 | Guest policy default for live rooms | Decided: `open` (no host, no pass), because the product is host-absent. Every guest drop waits for an Open click on the screen, which proves presence and likely supplies the gesture `ms-powerpoint:` needs (T3). `pass` (host-issued guest link) stays an optional per-room setting IT can turn on |
| OD-3 | Require registered screens for live OneDrive sessions | Yes, per org, once registered rooms ship; until then the unregistered warning |
| OD-4 | Link IP binding default | `log`, then `enforce` per room after T3 shows Office and the browser share an egress IP |
| OD-5 | GDPR roles, lawful bases and retention periods | Section 8's proposal; the legal lane confirms |
| OD-6 | Add "Start Over" to the screen's scanned and choosing states (design change) | Decided: yes, it is in |
| OD-7 | When to leave the free tier | When daily requests pass 60% of the cap for a week |
| T3 | Does PowerPoint follow a 302 from `/f/`? What does it request (OPTIONS, HEAD, PROPFIND, GET count)? Does it append a query? Does the browser prompt or need a click before `ms-powerpoint:`? Do Office and the browser share an IP? | decides ADR 0003, OD-4 and the link fetch limits |
| T20 | Residue after end, sign-out and reboot, including the Graph URL in redirect mode, the download history, and whether `Clear-Site-Data` runs | decides the residue claims and OPEN-03 |
| F-PDF | The PDF view under the final CSP on the lectern browser | OPEN-08 |
| F-ENTRA | On the demo tenant: issuer check, stolen-token redemption after secret rotation, the listing call, `Files.Read.Selected`, and the Graph download host list | AUTH-01, AUTH-04, AUTH-06, OPEN-04 |
| F-CF | D1 and R2 `eu` jurisdiction on the real account; whether R2 needs a card (fallback: guest bytes as chunks in the Screen object, not built); that the lifecycle JSON in `tools/r2-lifecycle.json` is accepted by `wrangler r2 bucket lifecycle set`; `FixedLengthStream` into R2 at the 50 MB cap (tested only on the local emulator) | ADR 0005 |

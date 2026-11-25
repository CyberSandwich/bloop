# ADR 0015: live pairing with accounts

Status: proposed. Amends ADR 0002 (pairing protocol) and ADR 0003's "resolve at fetch". Sign-in: ADR 0014. Data model: ADR 0013. Mode gate: ADR 0026.

## Context
- A live screen today accepts any phone. The owner path lists files from the source `FILE_SOURCE` names (`src/worker/source-access.ts`), and in production that is the mock, so a live Approve shows the sample deck. With accounts, a live owner claim must list the signed-in user's library.
- The claim route (`src/worker/routes/pairing.ts`) looks a code up in the Directory, which only routes and counts misses; the Screen object spends the code when it applies `claim` (`src/worker/machine.ts`). Only the Directory knows whether a code belongs to a demo or a live screen.
- Reverse QRLjacking: an attacker opens their own live screen and gets a signed-in victim to pair it, then to approve a library file onto it. Codes rotate every 60 s, so a QR printed on a poster or sent in an email is already dead when read; a working attack has to relay a fresh code to the victim live (a cloned room page, a screen share, a page that polls the attacker's screen).
- The passive 2-digit match (PAIR-04) relies on the victim comparing two numbers, which people skip.
- A sign-in round trip (an emailed code) usually takes longer than a code's 60 s life plus 10 s grace.

## Decision

### Claim checks the cookie before the code is spent (PAIR-15 auth-first)
- The claim route resolves the session cookie first (one D1 read; no cookie is no read), before the Directory and before the Screen object.
- It passes `{kind, signedIn}` to `Directory.lookup`. For a live code with `kind = owner` and no signed-in user, the Directory answers `auth_required` without routing to the Screen, and records the attempt as a miss against the IP hash. The code is never marked consumed, so the real presenter can still claim it.
- `auth_required` does tell a prober that a live code exists, which `code_unknown` does not. It is rate-limited like a miss (the same exact per-IP count) and gives nothing a guest claim on the same code would not: a guest claim already reveals a live code and pairs it.
- A demo code needs no cookie, as today. A live `guest` claim needs no cookie either: the account-free guest send keeps working in both modes.
- The signed-in user id goes into `pairing.userId` at claim and is **pinned**, together with the claiming session's `public_id`: `listed`, `approve`, the notes route and every later owner call require the cookie user to equal it, else `pairing_invalid`. Today's `approveItems` override (made for claim-then-sign-in) that lets approve carry a newer account is removed.
- In preview with `preview_lockout` set, a signed-in user outside `ADMIN_EMAILS` plus `TEST_EMAILS` counts as signed out (ADR 0026).

### The match pick (PAIR-14 match)
- At claim, the Screen object draws the 2-digit match as today and two distinct decoys, uniform over 00 to 99 and different from the match and each other. The claim response and the phone view carry `choices` (the three in random order) and never say which is real. The screen view carries only `match`.
- The phone asks "Which number is on the screen?" The user taps one. `POST /api/match {choice}` (Bearer pid, `RL_CONTROL`, `choice` matching two digits) applies a new machine event `match`:
  - right: `pairing.confirmed = true`, push both views;
  - wrong: the claim drops to `waiting` exactly as Cancel does (codes wiped, a fresh code issued, audit `canceled` with cause `match_wrong`). There is one pick per claim; a second `match` on a confirmed pairing is a no-op success, on any other state `wrong_state`.
- **Every live claim, owner or guest, must confirm** before `listed`, `approve`, `upload.start` or the upload routes; each answers `match_required` until then. A guest's file sent to an attacker's screen is the same harm, so guests confirm too. Demo screens skip the pick: their files are bloop's samples, and the demo must stay one tap.
- The claim timeout (5 min) covers the unconfirmed state; nothing new times out.
- **What it defends, honestly:** it defends only when the attacker does not control the display the victim reads the number from. A victim who scans a relayed code while looking at the real room screen (a sticker relay, a cloned page shown beside the real screen) sees a number that matches none of the choices or picks wrongly, and a wrong pick kills the attacker's pairing; a guess is right 1 time in 3. It does not defend a relay where the attacker also controls what the victim looks at (a fake lectern page, a screen share), since any working relay is live and can show the real number. That stays residual on PAIR-03.
- Shoulder-surfed codes are defended by neither control: the first claim wins, the real presenter sees the screen taken and starts over, and no victim file is exposed (PAIR-02).

### The screen never holds an account (PAIR-16 view)
- `pairing.userId` stays in the Screen object. `ScreenView` gains only per-item derived flags `{slides, pdf, pages, motion}` and `upload {bytes, total}`; it never carries a file id, version, user id, email, session id or notes flag. The SRC-01 test is extended to the new fields, and a schema test asserts the screen view's exact key set.
- Session links and bundle links are minted by the Screen object as today (ADR 0003), so the screen holds only links that die at session end.

### Early access and resume (open mode)
- `/a` calls `GET /api/me` **before** claiming. Signed in: claim as owner. Signed out, in open mode, on a live code: the phone does not claim and shows the "Early Access Only" sheet with four actions:
  - **Sign In:** stores `{code, at}` in `sessionStorage` and goes to `/signin?next=/a`. `next` is checked against an allowlist of exact paths (`/a`, `/library`, `/account`); anything else becomes `/library`. On return, `/a` re-claims if less than 70 s have passed, else shows "Scan the Screen Again". A passkey sign-in fits inside the window; an emailed code usually does not, and the rescan is the expected path, not an error.
  - **Try the Demo**, **Join the Waitlist** (Tally), **Send a File Without an Account** (a guest claim, which then confirms the match like any live claim).
- In preview the sheet never shows (MODE-01): a signed-out phone on a live code gets the guest send, as today minus the mock list.
- No code is held for a signed-out phone, so the sheet cannot be used to park someone else's screen.

### The library FileSource
- A new FileSource kind, `library`, in the file-source seam. `FILE_SOURCE=library` in production. Mock stays for tests only; production runs mock today, so in the same change that sets `library` the config check starts refusing `FILE_SOURCE=mock` on an https origin (a demo screen uses its own demo source whatever `FILE_SOURCE` says). Live owner access always uses the pinned cookie user; this removes the sample-deck Approve bug at its root.
- `listRecent` returns the user's files that pass the serving predicate below, selected ones first (`idx_lib_selected`), then up to 50 by `updated_at`.
- **The serving predicate**, one function used at listing, at approve and at every fetch: the file belongs to the pinned user, `status = 'ready'`, `trashed_at` and `disabled_at` are NULL, the version equals the ref's, and the user is active (`status = 'active' AND suspended_at IS NULL`).
- **Approve** stores each item as `source: "library"`, `ref = fileId:version`, and validates every ref with the serving predicate in one D1 query, not only by membership of the listing the phone saw. The machine's live cap of one file becomes 12 library items (P1's schema step adds `pairing.confirmed`, the library items, the derived flags and the upload progress).
- **Re-checked at fetch time (LIB-03 fetch-time).** Every `/f/` and `/b/` fetch resolves through the Screen object's `UsedLink.userId` (the pinned user); a `/p/` owner preview names its file and version in the signed token (ADR 0018) and its owner comes from the row. Then the serving predicate runs. Any miss is the same `404 link_unknown` body (ADR 0003's refusal rule). So trash, disable, suspension, a deletion request, the purge and a replaced version each stop a link on its next request. Bytes stream from R2 with ranges.
- **Fetch-check cache:** a passing check is cached per isolate for 5 s, keyed by link and file version, so a video's range reads do not each cost a D1 read. A refusal is never cached. So a revocation reaches a link within 5 s at most.
- `resolvePdf` returns the derived PDF when the derived row says it exists, else `pdf_unavailable`.
- Purge effects touch only `source: "guest"` files: ending a session never deletes a library file. A unit test pins it.

### Live screens follow the account (revocation mid-session)
- `UserLibrary.screens` records each screen the user started with the claiming session's `public_id`. Approve calls `screenStarted`; end, cancel and timeout call `screenEnded`.
- **Sign out** ends the screens that session started. **Sign out everywhere**, **suspension** and a **deletion request** call `endScreens` (every screen of the user), and delete the user's other sessions (all of them, for sign-out everywhere and suspension). The **purge** calls `endScreens` at its step 1 (ADR 0013).
- Ending goes through each Screen object's own `end`, so links are revoked and guest residue purged exactly as when the phone ends a talk.

### Speaker notes (NOTES-01 phone-only)
- Notes are stored under their own prefix, `u/<uid>/<fid>/v<n>/n/`, apart from the bundle assets under `d/`. The bundle handler maps only into `d/`, so no bundle path can address a notes object; a test asserts the bundle allowlist refuses every notes path.
- `GET /api/notes?item=<id>`: Bearer pid only (a sid is refused), the pinned cookie user for an owner pairing, session in `approved`, `opening` or `open`, item from the server's own session list, its derived row has notes. The Worker builds the R2 key from server state and answers JSON with `Cache-Control: no-store`. Notes are never minted as a link and never served by the file origin.
- Guest items with notes are served the same way to the guest's pid. Demo items have none.

## Rejected
- **Cookie check before the Directory lookup with no code knowledge**: the route cannot tell a demo code from a live one before the lookup, so it would demand a cookie for the demo. The lookup does not spend a code, so checking inside the lookup, before the Screen, keeps the invariant.
- **Typing the screen's number into the phone:** stronger against a guess (1 in 100) but slower and error-prone on a lectern, and no stronger against a relay that controls the display. Revisit if relay attacks are seen.
- **Holding the code while a signed-out phone signs in:** a stranger could park any screen.
- **Putting the user on the screen view "for display":** the screen is untrusted (section 9 of the threat model).
- **Checking ownership only at approve:** a file trashed or disabled mid-talk would keep serving.
- **Notes inside the bundle prefix behind an allowlist:** one allowlist bug would put notes on the screen; a separate prefix makes it unreachable.

## Consequences
- One extra tap for every live claim; demo is unchanged.
- A signed-in user's code is checked once at claim and pinned; a user who signs out mid-pairing loses the pairing's owner actions, and their screens end.
- At most one D1 read per link per 5 s per isolate while a file is served.
- `interfaces.md` gains the library source, the serving predicate and the `match` event (P1 owns it).

## Threats served
PAIR-14, PAIR-15, PAIR-16, NOTES-01, LIB-01, LIB-03, SRC-01, SRC-02, SRC-04, PAIR-02 and PAIR-03 (narrowed, still residual), AUTH-13 (screens end with the session), MODE-01.

## How to remove it
- The pick: drop the `match` event and `confirmed`, and the screen falls back to the passive match (a schema step that sets `confirmed` true on wake).
- Accounts on live screens: set `FILE_SOURCE` back and remove the `auth_required` branch from the lookup; guests are unaffected.

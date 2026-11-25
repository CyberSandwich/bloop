# ADR 0015: live pairing with accounts

Status: proposed. Amends ADR 0002 (pairing protocol) and ADR 0003's "resolve at fetch". Fable reviews it before any code is written against it. Sign-in: ADR 0014. Data model: ADR 0013. Mode gate: ADR 0026.

## Context
- A live screen today accepts any phone. The owner path lists files from the source `FILE_SOURCE` names (`src/worker/source-access.ts`), and in production that is the mock, so a live Approve shows the sample deck. With accounts, a live owner claim must list the signed-in user's library.
- The claim route (`src/worker/routes/pairing.ts`) looks a code up in the Directory, which only routes and counts misses; the Screen object spends the code when it applies `claim` (`src/worker/machine.ts`). Only the Directory knows whether a code belongs to a demo or a live screen.
- Reverse QRLjacking: an attacker opens their own live screen and shows its QR somewhere else (an email, a poster, a cloned room page). A signed-in victim who scans it pairs the attacker's screen and may approve a library file onto it. The passive 2-digit match (PAIR-04) relies on the victim comparing two numbers, which people skip.
- A sign-in round trip (an emailed code) usually takes longer than a code's 60 s life plus 10 s grace.

## Decision

### Claim checks the cookie before the code is spent (PAIR-15 auth-first)
- The claim route resolves the session cookie first (one D1 read; no cookie is no read), before the Directory and before the Screen object.
- It passes `{kind, signedIn}` to `Directory.lookup`. For a live code with `kind = owner` and no signed-in user, the Directory answers `auth_required` without routing to the Screen, and records the attempt as a miss against the IP hash. The code is never marked consumed, so the real presenter can still claim it, and `auth_required` costs a prober the same as a wrong code, so it is no oracle for live codes.
- A demo code needs no cookie, as today. A live `guest` claim needs no cookie either: the account-free guest send keeps working in both modes (Part 1).
- The signed-in user id goes into `pairing.userId` at claim and is **pinned**: `listed`, `approve`, the notes route and every later owner call require the cookie user to equal it, else `pairing_invalid`. Part 2's "approve may carry a newer account" (today's `approveItems` override, made for claim-then-sign-in) is removed: with sign-in before claim, a second account mid-pairing is an attack or a mistake, never the flow.
- In preview mode, a signed-in user outside `ADMIN_EMAILS` plus `TEST_EMAILS` counts as signed out (ADR 0026).

### The match pick (PAIR-14 match)
- At claim, the Screen object draws the 2-digit match as today and two distinct decoys, uniform over 00 to 99 and different from the match and each other. The claim response and the phone view carry `choices` (the three in random order) and never say which is real. The screen view carries only `match`.
- The phone asks "Which number is on the screen?" The user taps one. `POST /api/match {choice}` (Bearer pid, `RL_CONTROL`, `choice` matching two digits) applies a new machine event `match`:
  - right: `pairing.confirmed = true`, push both views;
  - wrong: the claim drops to `waiting` exactly as Cancel does (codes wiped, a fresh code issued, audit `canceled` with cause `match_wrong`). There is one pick per claim; a second `match` on a confirmed pairing is a no-op success, on any other state `wrong_state`.
- **Every live claim, owner or guest, must confirm** before `listed`, `approve`, `upload.start` or the upload routes; each answers `match_required` until then. Part 2 named owner claims only; a guest's file sent to an attacker's screen is the same harm, so guests confirm too. Demo screens skip the pick: their files are bloop's samples, and the demo must stay one tap.
- The claim timeout (5 min) covers the unconfirmed state; nothing new times out.
- What it defends, stated as honestly as PAIR-04: a QR shown away from its screen (email, poster, sticker, a screen the victim is not looking at) now needs the victim to pick the right number from three without seeing it, a 1 in 3 chance per scan, and a wrong pick kills the attacker's pairing. It does not defend a live relay where the attacker also shows the victim their screen's number in real time; that stays residual on PAIR-03.

### The screen never holds an account (PAIR-16 view)
- `pairing.userId` stays in the Screen object. `ScreenView` gains only per-item derived flags `{slides, pdf, pages, motion}` and `upload {bytes, total}`; it never carries a file id, version, user id, email or notes flag. The SRC-01 test is extended to the new fields, and a schema test asserts the screen view's exact key set.
- Session links and bundle links are minted by the Screen object as today (ADR 0003), so the screen holds only links that die at session end.

### Early access and resume (open mode)
- `/a` calls `GET /api/me` **before** claiming. Signed in: claim as owner. Signed out, in open mode, on a live code: the phone does not claim and shows the "Early Access Only" sheet with four actions (Part 1; Part 2 listed three):
  - **Sign In:** stores `{code, at}` in `sessionStorage` and goes to `/signin?next=/a`. `next` is checked against an allowlist of exact paths (`/a`, `/library`, `/account`); anything else becomes `/library`. On return, `/a` re-claims if less than 70 s have passed, else shows "Scan the Screen Again". A passkey sign-in fits inside the window; an emailed code usually does not, and the rescan is the expected path, not an error.
  - **Try the Demo**, **Join the Waitlist** (Tally), **Send a File Without an Account** (a guest claim, which then confirms the match like any live claim).
- In preview the sheet never shows (MODE-01): a signed-out phone on a live code gets the guest send, as today minus the mock list.
- No code is held for a signed-out phone, so the sheet cannot be used to park someone else's screen.

### The library FileSource
- A new FileSource kind, `library`, in the file-source seam. `FILE_SOURCE=library` in production. Mock stays for tests only; production runs mock today, so in the same change that sets `library` the config check starts refusing `FILE_SOURCE=mock` on an https origin (a demo screen uses its own demo source whatever `FILE_SOURCE` says). Live owner access always uses the pinned cookie user; this removes the sample-deck Approve bug at its root.
- `listRecent` returns the user's files that are `ready`, not trashed and not disabled, selected ones first (`idx_lib_selected`), then up to 50 by `updated_at`.
- Approve stores each item as `source: "library"`, `ref = fileId:version`. The machine's live cap of one file becomes 12 library items (P1's schema step adds `pairing.confirmed`, the library items, the derived flags and the upload progress).
- **Re-checked at fetch time (LIB-03 fetch-time).** Every `/f/` and `/b/` fetch resolves through the Screen object's `UsedLink.userId` (the pinned user); a `/p/` owner preview names its file and version in the signed token (ADR 0018) and its owner comes from the row. Then one D1 query re-reads: the file belongs to that user, `status = 'ready'`, `trashed_at` and `disabled_at` are NULL, `version` equals the ref's, and the user's `status` is `active`. Any miss is the same `404 link_unknown` body (ADR 0003's refusal rule). So trash, disable, suspension, account deletion and a replaced version each stop a link mid-talk on its next request. Bytes stream from R2 with ranges.
- `resolvePdf` returns the derived PDF when the derived row says it exists, else `pdf_unavailable`.
- Purge effects touch only `source: "guest"` files: ending a session never deletes a library file. A unit test pins it.
- Approve calls `UserLibrary.screenStarted`; end, cancel and timeout call `screenEnded`. Sign out everywhere, suspension and the account purge call `endScreens`, which ends each listed screen through its Screen object.

### Speaker notes (NOTES-01 phone-only)
- Notes live in a separate derived object per file version and never in the slide manifest the screen fetches.
- `GET /api/notes?item=<id>`: Bearer pid only (a sid is refused), the pinned cookie user for an owner pairing, session in `approved`, `opening` or `open`, item from the server's own session list, its derived row has notes. The Worker reads the R2 key from server state and answers JSON with `Cache-Control: no-store`. Notes are never minted as a link, never served by the file origin, and the bundle allowlist cannot match them (a test asserts the allowlist refuses the notes path).
- Guest items with notes are served the same way to the guest's pid. Demo items have none.

## Rejected
- **Cookie check before the Directory lookup with no code knowledge** (Part 2's literal wording): the route cannot tell a demo code from a live one before the lookup, so it would demand a cookie for the demo. The lookup does not spend a code, so checking inside the lookup, before the Screen, keeps the invariant.
- **Typing the screen's number into the phone:** stronger (1 in 100) but slower and error-prone on a lectern; the pick is 1 in 3 with one tap, and a wrong pick kills the attacker's attempt. Revisit if relay attacks are seen.
- **Holding the code while a signed-out phone signs in:** a stranger could park any screen.
- **Putting the user on the screen view "for display":** the screen is untrusted (section 9 of the threat model).
- **Checking ownership only at approve:** a file trashed or disabled mid-talk would keep serving.

## Consequences
- One extra tap for every live claim; demo is unchanged.
- A signed-in user's code is checked once at claim and pinned; a user who signs out mid-pairing loses the pairing's owner actions.
- Every file fetch costs one D1 read. At a video's range reads that is many reads per talk; the read is a primary-key lookup and the per-link `RL_FETCH` already bounds the rate.
- `interfaces.md` gains the library source and the `match` event (P1 owns it).

## Threats served
PAIR-14, PAIR-15, PAIR-16, NOTES-01, LIB-01, LIB-03, SRC-01, SRC-02, SRC-04, PAIR-03 (narrowed, still residual), MODE-01.

## How to remove it
- The pick: drop the `match` event and `confirmed`, and the screen falls back to the passive match (a schema step that sets `confirmed` true on wake).
- Accounts on live screens: set `FILE_SOURCE` back and remove the `auth_required` branch from the lookup; guests are unaffected.

## Flags (Part 2 unsafe, ambiguous or contradicting Part 1, and the resolution)
1. **Contradiction:** Part 2 checks the cookie "before the Directory lookup", which breaks the demo. Resolved: inside the lookup, before the Screen; the attempt counts as a miss.
2. **Gap (unsafe):** Part 2 left live guest claims without the cookie check and without the match pick, so reverse QRLjacking still worked against guest files, and PAIR-15's "stranger spends a live code" still holds for a guest claim. Resolved: guests confirm the match; a stranger may still occupy a live screen as a guest, as today (PAIR-02, first claim wins, Start Over).
3. **Unsafe:** the phone view carrying the real `match` beside the choices would let page code or a screenshot reveal it. Resolved: the phone gets only the shuffled `choices`.
4. **Ambiguous:** account switch mid-pairing. Resolved: the claim's user is pinned.
5. **Contradiction:** Part 1's sheet has four actions, Part 2's three. Part 1 wins.
6. **Ambiguous:** the sheet in preview. Resolved: never shown; guest send only.
7. **Timing:** "on return it re-claims" will usually fail for code sign-in (60 s codes). Resolved: rescan is the designed path, the copy says so, and UX should treat it as the main flow.
8. **Ambiguous:** notes "live only". Resolved: pid only for any item with notes; the mode is not the control.

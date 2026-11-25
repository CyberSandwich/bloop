# bloop v4 UX spec

The screens v4 adds, as annotated mockups. `docs/design.md` stays the single source for tokens, glass, type, copy rules and every part it already names; these files only arrange those parts and name the strings. Where a screen needs something design.md does not have, it is proposed in "design.md additions" at the end of this file, and S or the builder applies it there; nothing here overrides design.md.

## Files

| File | Covers |
|---|---|
| README.md | the core flow decision, conventions, the lazy-load map, design.md additions |
| landing.md | both landing modes (preview, open), the nav pill that reads Sign In or Library, the waitlist block |
| signin.md | `/signin`, `/invite`, the email code, the passkey offer, passkey sign-in |
| library.md | `/library` on a phone and a desktop: list, Up Next, add, rename, trash, preview, quota |
| present-live.md | packing a talk, the Present sheet, the scan, the 1-of-3 match pick, the early-access state and its resume, approve, the live phone while presenting (notes) |
| upload.md | the upload pill: "34 of 88 MB", "Checking Your File", "Sent"; resume, pause, refusals |
| viewers.md | the room screen with library items: slides, PDF, sheet and text viewers, the over-30 MB choice sheet, the honesty toast, the receiving pill, Report |
| account-admin.md | `/account`, `/admin` (invites, waitlist, reports, users, the mode switch and the launch checklist), `/report` |
| states.md | empty, error, slow and offline for every surface, plus the in-between states nobody named |

## The core flow: library, Up Next and Present Live

The hard case: a lecturer walks into a room with 3 minutes to spare, phone in one hand, maybe a coffee in the other. From the phone leaving the pocket to the first slide on the wall should take under 10 seconds.

**Decision: pack ahead, scan to present, and the match tap is the approval.**

1. At the desk, the day before or on the walk over, the lecturer marks files in the library as **Up Next** (a trailing tick on each row; a server flag, `selected_at`, at most 12). This is the only choosing step, and it happens where there is time.
2. At the lectern the room PC shows the QR (bloop.here/s, or Present Live on the landing). The lecturer scans with the phone's own camera.
3. `/a` opens signed in, reads the user's Up Next from their own library, and shows it above three numbers. The lecturer taps the number the screen shows. That one tap confirms the match (PAIR-14) and approves the Up Next files: the phone sends `/api/match`, then `/api/approve` with the Up Next ids, in order, as one action. No second Approve screen.
4. The screen opens the first file (PowerPoint for a deck, or the choice sheet over 30 MB); the rest wait in its list.

Time budget on a warm phone: camera and scan about 3 s, `/a` paint and claim about 1.5 s, reading the files and finding the number about 2 s, approve and the screen's first paint about 2 s. About 8.5 s with one tap on the phone. Nothing packed: the same match tap leads to the list (Up Next first, then the newest ready files), one tick, Approve: two taps, about 11 s.

Why this one: it moves the only real decision (which files) to where there is time, keeps the camera app as the scanner (already one swipe from the lock screen, and it is what people trust), and puts the one tap at the bottom of the screen where a thumb rests. The files are listed right above the numbers, so the tap that commits is made while reading what it commits, which is what Approve (42) did, minus a step.

Rejected, one line each:
- **Scanner inside the library page:** a camera permission prompt, no `BarcodeDetector` in iOS Safari, a vendored decoder on the critical path, and slower than the camera on the lock screen.
- **Choosing at the lectern from the whole library:** scrolling and searching one-handed under a clock; it is the fallback when nothing is packed, never the main path.
- **Push from the library to a recent screen, no scan:** the screen holds no account, so a code is the only way to name it, and a list of screens reopens reverse QRLjacking.
- **Match pick, then a separate Approve screen:** one more tap and one more screen with nothing new on it, since the files are already shown above the numbers.
- **Typing the 2 match digits:** slower than picking 1 of 3, and error-prone one-handed.
- **Up Next cleared after each talk:** a weekly lecturer would re-pack every week; the "Last Presented" line and its one-tap swap catch a stale pack instead.

Changes for builders: L stores Up Next (`selected_at`, already in migration 0005); P2 builds the combined tap in `/a` (no protocol change: two calls in order, and a refused approve after a confirmed match falls back to the list, never a dead end); P1 keeps `approve` refused until `confirmed`, which the client order satisfies. Detail and every state: present-live.md.

## Conventions in these files

**Viewports.** Every screen is drawn at 390 (phone) and 1440 (desktop), and at 844x390 (phone on its side) where the layout changes. The CI shot sizes stay design.md's (320, 390, 430, 844x390, 834, 1440); a mockup at 390 holds at 320 unless its note says what wraps.

**Mockup legend.**

| Mark | Part (design.md section) |
|---|---|
| `[[ Label ]]` | primary pill, ink (6, Buttons) |
| `[ Label ]` | secondary pill, white with a hairline ring |
| `( Label )` | text button, 44 hit area |
| `[! Label !]` | rose pill (End, Revoke, Delete) |
| `<Back` | the house frame Back (6, House frame) |
| `.-----.` and `'-----'` | a glass surface (4, Glass) |
| `+-----+` | a white card or field (`--surface`) |
| `#####` | the loader's fill; `~~~` the loader's sheen (6, Loader) |
| `[x]` and `[ ]` | a row's trailing tick on and off (6, Item row) |
| `(i)` | a 24 px Lucide glyph, named in the note |
| `.._..` | a skeleton bar (`--g1`) |

**Strings.** Every quoted string is the shipped string, character for character. Controls, titles and status pills are Title Case; lines are sentences with a period. "early access", never "beta". No "we", no "session" or "token" on a user screen (the existing "Session Ended", "End Session" and "Session Expiry" stay, per design.md section 3). Numbers in strings come from the API or config at runtime (quota, file cap, code life); the figures in mockups are examples, and no string restates a limit as a constant.

**Every screen lists:** states and transitions, focus order, tap targets (44 minimum, 52 for a page's actions), motion (from design.md section 8 only), and which lazy module loads on which intent.

## Shared rules for the new pages

- **Frame.** `/signin`, `/invite`, `/library`, `/account`, `/admin` and `/report` are app pages: `base.css` then `app.css`, the corner bar, no site nav or footer (design.md section 5). `/library` and `/admin` widen the column (library.md, account-admin.md); the auth pages keep `/a`'s 480 column.
- **The bottom action panel** (`/a`'s sticky glass panel, design.md section 7, Phone page) is the one place a phone page's actions sit under 640 wide, or under 600 tall below 900 wide. Every new phone page uses it, so a thumb always finds the next step in the same place.
- **Focus** moves to the new title on every state change (as `/a`); errors are `role="alert"`, status lines `role="status"`.
- **One loader.** Anything on its way uses the loader (design.md section 6); a skeleton (`--g1` bars) only for text whose length is unknown.
- **Signed-in hint.** `__Host-bloop_in` is a non-secret cookie A sets at sign-in and clears at sign-out; it only chooses a label (Sign In or Library). Every page that needs to know for sure asks `GET /api/me`.
- **Mode.** In preview, the account surfaces exist only for `ADMIN_EMAILS` and `TEST_EMAILS` (MODE-01), and nothing advertises them:
  - `/signin` is served but linked from nowhere and `noindex`; every address gets the same "if" answer, and codes go only to allowed emails (signin.md section 9).
  - Signed out, `/library`, `/account` and `/admin` answer the 404 page, never a sign-in prompt. Only in open do they redirect to `/signin?next=`.
  - `/open/*` (the open variant's build path) is never a public path in either mode: it answers 404 (landing.md section 1).
  - `/report` is public in both modes (account-admin.md section 3); a Report link shows in preview only where reporting works (viewers.md section 7).

## Lazy-load map (first load carries only the first paint and the first likely tap)

| Page | First load | Lazy, and the intent that fetches it |
|---|---|---|
| landing (open) | today's `site.js` | none new; the Sign In or Library label is set by the Worker (landing.md) |
| `/signin`, `/invite` | the page script, the email step | Turnstile script: on focus of the email field; webauthn module: at load only where `PublicKeyCredential` exists (conditional mediation must be armed before the first tap); the passkey offer: after the code verifies |
| `/library` | list render, Up Next ticks | upload module and the pill: pointerdown or focus on Add Files, or the first file drag; row menu (rename, trash): pointerdown on a row's More; preview: pointerdown on a row; sort and trash view: pointerdown on Sort; the Present sheet: pointerdown on Present; the progress socket: only while a row is uploading or preparing |
| `/a` (live, signed in) | today's phone script | match pick: on a claim answered `claimed` with a cookie; early-access state: on `auth_required`; notes: on approval of an item with notes; the upload pill: as `/library` |
| `/s` | today's screen script | each viewer on the first item of its kind; the choice sheet: on an item over 30 MB; the honesty toast's module: with the first viewer that needs it; the receiving pill: on the first `upload.progress` |
| `/account` | profile, devices | export, delete, email change: pointerdown on their buttons; passkey create: pointerdown on Add a Passkey |
| `/admin` | the tab shown first (Invites) | each other tab on pointerdown of its tab; the launch checklist with the Launch tab |

Each lazy module keeps a working fallback when its import fails (design.md section 11): named per screen in its file.

## Open questions decided here (each with the reason)

1. **Match tap approves Up Next.** Decided above; it needs no protocol change.
2. **Up Next survives a talk.** A weekly lecture reuses it. A pack whose files were all presented, with nothing ticked since, says "Last Presented 18 Nov" in ink above its rows and offers each file added since as one tap, "Use Lecture 6.pptx Instead", with the numbers left where they are (present-live.md 3.2); a true repeat needs no extra tap.
3. **The library's upload ends on "Saved", the guest's on "Sent".** A guest's file goes to a screen; a library file goes nowhere yet, and "Sent" there read as if it had reached a room. Both share every other pill string.
4. **The upload pill replaces the guest row's loader on `/a`.** One loader on screen at a time (design.md section 6); the row stays as the file's face.
5. **Early access on `/a` is a page state, not a bottom sheet.** It is the whole answer to a signed-out scan, it keeps Back, and its actions sit in the one action panel; a sheet over nothing would be a page in disguise.
6. **The first Up Next file opens by itself on the screen.** One scan and one tap to the first slide (product principle 1); the others wait in the screen's list.
7. **Notes follow the screen's page only when bloop's viewer shows the deck.** When PowerPoint presents, bloop cannot see the page, so the phone lists every slide's notes in order instead of guessing.
8. **Present Live stays visible under 640 on the landing.** `/s` already answers a phone with "Use the Room's Screen"; hiding the button would make the two layouts disagree about what the product does.
9. **The Sign In or Library label is set by the Worker, not `site.js`.** A module script runs after the first paint, so the label would flash; the Worker already picks the page per request by mode.
10. **The live phone's page controls** (Previous, Next under the preview) show only while bloop's viewer shows a deck, and only if P1 extends PAIR-13 to live library sessions; until then the live phone shows notes and the page read only. P1 decides; the fallback is fully specified.

## design.md additions (proposed; S and the builders apply them to design.md, not here)

**Tokens (base.css `:root`, then design.md section 4):**
- `--match-h:64px`: the height of a match pick choice (present-live.md). 52 is a page action; a choice read at arm's length and hit one-handed gets the next step up, and 64 keeps three across at 320 (each about 85 wide).
- No other new token. Every other size here is an existing token or derives from one.

**Parts (design.md section 6):**
- **Upload pill** (upload.md): a user of the loader shaped as a pill (`--r-pill`, 56 tall: 8 + a 40 tile + 8, so the tile is concentric), glass, floating `--inset` above the bottom action panel or the window's foot, max 360, a title (15/600) and one line (13 `--muted` tabular). One per page; several files fold into it.
- **Match pick** (present-live.md): a `fieldset` of three radio-like buttons, each a secondary pill `--match-h` tall sharing the row, the digits 28/600 tabular Inter (not mono: mono is the room screen's number only), legend visible.
- **Toast with an action** (library.md): the toast (design.md section 8) gains one optional text button at its end ("Undo"), 44 hit area; such a toast stays 8 s instead of 5, since the action needs reading time, and pauses while hovered or focused. The upload pill's Saved state with Add to Up Next follows the same rule (upload.md section 2).
- **Screen toast** (viewers.md): the same toast part on `/s`, bottom center at `--inset`, over the stage, never over the control pill (it rises above the pill when they would meet), hidden while presenting.
- **Choice sheet** (viewers.md): the `.leave` question card's layout (design.md section 7, Screen page) with three actions instead of two; the screen's only new dialog.
- **Status chip on a row** (library.md): the Connect panel's status chip (design.md section 6) at 13 px inside an item row's line 2, for "Preparing Slides" (`--amber` pair) and "Can't Show Slides" (`--rose` pair). A state on a row, so the pastel pairs that already mean "not yet" and "stop".
- **Segmented tabs** (account-admin.md): the nav pill's link pills (44, `--wash` hover, the selected pill `--g-select` with `--ink`) reused as page tabs on `/admin`; no new look.

**Section 3, strings:** add the v4 rows from these files' string tables under a new "Accounts and library" heading, and add `beta` to `tools/never-say.txt` (S owns it), so "early access" is enforced, not only written.

**Section 7, Phone page:** the guest sending row loses its loader to the upload pill (decision 4); the live approve state gains the match pick and the combined tap (present-live.md); `Approve (42)` stays for the demo and the guest send.

**Section 12, Targets:** add the 64 px match choice to the target list.

# Picking files for a talk, then Present Live

The core flow (README.md, "The core flow"): pack Up Next in the library, scan the room screen, tap the screen's number. This file covers the phone from the Present button to the slide on the wall, and the signed-out branch. The library list itself is library.md; the screen's side is viewers.md.

## 1. Packing: Up Next in the library

Up Next is a flag on library files, at most 12 (`PATCH /api/library/:id {selected}`). It is the order the screen lists them in: the order they were ticked, oldest first, so the first tick is the file that opens first.

```
390                                       1440 (library.md has the full page)
.--------------------------------------.  right column of /library:
| Up Next                     ( Clear ) |  .--------------------------------.
| +--+ Lecture 5.pptx              [x] |  | Up Next                ( Clear )|
| |PP| PowerPoint · 18 MB              |  | 1 +--+ Lecture 5.pptx       [x] |
| +--+                                 |  | 2 +--+ Reading list.pdf     [x] |
| +--+ Reading list.pdf            [x] |  |                                 |
| |PD| PDF · 2 MB                      |  | Opens First: Lecture 5.pptx     |
| +--+                                 |  | [[ Present ]]                   |
'--------------------------------------'  '--------------------------------'
```

- On a phone, Up Next is the top group of the library list (library.md, section 2): a group label "Up Next" (14/600 `--muted`, the design.md group label) and the ticked rows in order, then "All Files", which lists every file, ticked ones too. A tick in All Files leaves its row where it is (a row never jumps from under the thumb while several are ticked in a row) and adds a copy to the end of Up Next, instantly, as row selection is.
- On a desktop it is its own glass card beside the list, numbered, since order matters there and there is room to show it; rows drag to reorder (pointer only). On every device, an Up Next row's More menu also has Move Up and Move Down (library.md section 4), so the phone and the keyboard can reorder too.
- A row has no tick until its upload says Saved (library.md section 2): Up Next never holds an unfinished upload, so the match state and the chooser never list one.
- "Clear" (text button) unticks every Up Next file, with the undo toast: "Up Next Cleared" / "Undo".
- The 13th tick: the tick does not turn on; toast "Up Next Is Full" / "A talk takes up to 12 files. Untick one first."
- A file still preparing can be ticked (it opens in PowerPoint either way); a refused file cannot (its tick is absent, library.md).

## 2. The Present button and the Present sheet

The library's bottom action panel holds Add Files and Present (library.md). Present reads "Present" always, with no count: a number in parentheses on a primary is the match digits' pattern ("Approve (42)"), and the Up Next group already shows what will go.

Tap Present (the sheet's module is fetched on pointerdown) and the Present sheet opens: the Session Expiry sheet's pattern (design.md section 7, Phone page: a modal `<dialog>` holding glass bubbles, `--pad` in from the sides and `--inset` above the bottom under 640, centered max 432 from 640).

```
390, Up Next has 2 files                  1440 (centered, max 432)
                                          .------------------------------------.
.--------------------------------------.  | Present on a Screen            (x) |
| Present on a Screen              (x) |  |                                    |
|                                      |  |  (monitor)  Open bloop.here/s on   |
|  (monitor)  Open bloop.here/s on the |  |  the room PC, then scan its code   |
|  room PC, then scan its code with    |  |  with your camera.                 |
|  your camera.                        |  |                                    |
|                                      |  |  Opens first: Lecture 5.pptx       |
|  Opens first: Lecture 5.pptx         |  |  [ Enter the Code ]  [[ Done ]]    |
|                                      |  '------------------------------------'
'--------------------------------------'
.--------------------------------------.
| [[             Done              ]]  |
| [         Enter the Code         ]   |
'--------------------------------------'
```

- Title "Present on a Screen" (22/600, the card title), with Close (`x`, the sheet's quiet icon button).
- Line, `--ink-2`, with a leading 24 px Lucide `monitor`: "Open bloop.here/s on the room PC, then scan its code with your camera." The address is the host from config, never typed into the string.
- "Opens first: Lecture 5.pptx" (15 `--muted`; the name in `--ink` 600, middle ellipsis). With Up Next empty instead: "Choose your files after you scan." Over 30 MB first file: "Opens first: Lecture 5.pptx. The screen asks how to open it, since it's 88 MB." (viewers.md, choice sheet).
- An upload still in flight on this page adds, under that line, one sentence per file in `--ink`: "Lecture 6.pptx is still uploading. Keep this page open until it says Saved." It leaves when the pill says Saved. The file is not in Up Next yet (section 1), so the sentence is the only place the lecturer learns it will not go.
- Bubble 2: Done (primary, closes) and Enter the Code (secondary, the label every code-entry button uses, as `/code`'s title; goes to `/code` in this tab, for a screen whose QR the camera will not read: glare, a projector across the room). Stacked under 640 with Done on top (Apple's order, design.md Buttons); side by side from 640, Done last.
- Why a sheet and not a page: it is an instruction, the library stays under it, and Done returns to the list in the same scroll position.
- Focus: the title on open (as the Session Expiry sheet), then Close, Enter the Code, Done in reading order; Escape and the backdrop close it.
- Fallback when the sheet's module fails to load: Present becomes a plain link to `/code`, whose page says the same thing.

**Present Live on the landing** (open mode, landing.md) is the room PC's way in: it opens `/s` in live mode, the QR at once. Nothing on the phone changes.

## 3. The scan: `/a` signed in, the match pick

The camera opens `/a?c=K7MQ9X`. The page claims the code (`kind: "owner"`, with an `Idempotency-Key` per attempt and the tab's `X-Bloop-Nonce`); the claim answers `auth_required` before it spends the code when there is no cookie, and only then does the page ask `GET /api/me`, beside loading the state's module (section 5).

**States in order:** checking, then match, then (after the tap) approving, then approved. Each is a state of `/a`'s one column, title focused on change.

### 3.1 Checking (up to the claim's answer)

As today's checking state (design.md section 7, Phone page): a skeleton title bar, "Checking the code.", no buttons. Under a slow network the skeleton stays; after 4 s the line adds "Still checking. Keep this page open." (states.md, slow).

### 3.2 Match, with Up Next packed

```
390 x 844 (one hand: the tap that commits is in the bottom third; Back and Change Files are the rare taps)

  <Back                                          (Back = Start Over: lets go of the claim)

  Room 2.14                                       title, 34/600, the room ([V-7] fallback "This Screen")
  Registered screen                               14 --muted, only for a registered room

  Up Next                                         group label, 14/600 --muted
  +------------------------------------+
  | +--+ Lecture 5.pptx                |          item rows, read only (a record, not controls)
  | |PP| PowerPoint · 18 MB            |
  | +--+ Reading list.pdf              |
  | |PD| PDF · 2 MB                    |
  +------------------------------------+
  ( Change Files )                                text button, opens the chooser (3.4)

  Only these files go to the screen. The screen    scope line, 15 --muted
  never gets your account.

.--------------------------------------.
| Tap the Screen's Number              |          legend, 15/600 --ink, visible
| [   42   ] [   17   ] [   86   ]     |          three choices, --match-h (64), digits 28/600 tabular
'--------------------------------------'
```

```
844 x 390 (phone on its side: two columns, as /a's desktop layout; the panel is one row)

  <Back
  Room 2.14                    | Up Next
  Registered screen            | +--+ Lecture 5.pptx
                               | +--+ Reading list.pdf
  Only these files go to the   | ( Change Files )
  screen. The screen never     |
  gets your account.           |
 .-----------------------------------------------------------------.
 | Tap the Screen's Number   [  42  ] [  17  ] [  86  ]            |
 '-----------------------------------------------------------------'
```

```
1440 (a laptop scanning with its webcam is rare; this is a phone on a desk-sized window or /code typed on a laptop)

         <Back
                      Room 2.14                    +-----------------------------+
                      Registered screen            | Up Next                     |
                                                   | +--+ Lecture 5.pptx         |
                      Only these files go to the   | +--+ Reading list.pdf       |
                      screen. The screen never     | ( Change Files )            |
                      gets your account.           +-----------------------------+

                      Tap the Screen's Number
                      [  42  ] [  17  ] [  86  ]   (in the left column, 24 under the scope,
                                                    as /a's buttons sit from 900)
```

- **Choices.** Three, in a random order each claim, one of them the screen's number. Decoys differ from the real number in both digits and are never a digit swap of it (a glance tells 42 from 24 less well than from 86); P1 generates them server side. Each choice is a `<button>` named "42" in a `fieldset` whose legend is "Tap the Screen's Number"; no choice looks selected before the tap.
- **Why 64 tall:** read at arm's length, hit with a thumb while the eye is on the wall; `--match-h` (README.md additions).
- **Room for the numbers.** The screen shows its number in the QR card at 0.4 of the card (design.md section 7, Claimed), so the eye moves from wall to thumb with nothing to read in between.
- **Up Next rows** are the item row (design.md section 6) without ticks, at most 4 shown; more fold into "+3 More Files" (a text button that expands the list in place).
- **A stale pack.** When every Up Next file has been presented already and nothing was ticked since, the match state says so above the rows, in `--ink` 600 at 15: "Last Presented 18 Nov" (the most recent `last_presented_at` among them; "Last Presented Today 10:02" on the same day). Under that line it lists any ready file added to the library since then (newest first, at most 3), each as an item row with a text button under its line 2, "Use Lecture 6.pptx Instead" (the name middle-ellipsized to fit one line; the accessible name is always the full name). A tap swaps that file into Up Next in place of the whole stale pack (PATCH, then the rows redraw), and the numbers stay exactly where they are, so the next tap is still the number. A true repeat (the same deck again) needs nothing: the number tap approves the pack as it stands.

```
390, stale pack, one file added since

  Room 2.14
  Last Presented 18 Nov                            ink 600, 15
  +------------------------------------+
  | +--+ Lecture 5.pptx                |
  +------------------------------------+
  +------------------------------------+
  | +--+ Lecture 6.pptx                |           added since
  | |PP| PowerPoint · 22 MB            |
  |      ( Use Lecture 6.pptx Instead )|           the swap: one tap
  +------------------------------------+
.--------------------------------------.
| Tap the Screen's Number              |
| [   42   ] [   17   ] [   86   ]     |           unchanged position
'--------------------------------------'
```
- **Focus order:** Back, the title (focused on entry), Change Files, the three choices left to right. Enter does nothing unless a choice is focused.
- **Motion:** the state enters with the house scene change only where `/a` already uses it (none: `/a` swaps instantly and moves focus). The choices appear with the panel, no stagger.
- **Lazy:** the match pick's module is fetched when the claim answers `claimed` for a signed-in phone; until it arrives (a few ms on a warm cache) the panel holds three skeleton pills of the same size, so nothing moves. If it fails to load: the panel shows "Match Didn't Load" with Reload (as "Remote Didn't Load"), and the claim is released after 2 minutes by the server as today.

### 3.3 The tap

- **Right number:** the tapped choice turns ink (primary fill, paper digits) at once, the other two go to disabled (.38), and the legend becomes "Approving..." with the spinner (design.md section 6 loading). The phone sends `/api/match`, then `/api/approve` with the Up Next ids in Up Next order. On success: the approved state (3.5). Perceived speed: the tap's feedback is instant; the screen's own change (its QR card's number turning into "Opening Lecture 5.pptx") is the real confirmation, usually before the phone's answer.
- **Slow approve:** after 4 s the legend's line under the choices reads "Still approving. Keep this page open." and the spinner stays. No 15 s stop: the approve may have landed, so the phone keeps waiting (states.md rule) and the socket's push settles it.
- **The same number twice.** Match is idempotent for the confirmed number: a second tap on it after `confirmed` (a retry after a lost answer, a reload, a double tap) answers success with no side effect, and the client resumes at approve. So a dropped answer between the two calls never strands the lecturer or burns the code.
- **Wrong number:** the claim is canceled server side and the screen shows a new code (PAIR-14). The phone shows a dead end, laid out as expired (design.md, centered): title "That Wasn't the Screen's Number", line "Scan the screen again, or type its code.", button Enter the Code (primary, the one exit). No retry on the same code: a second guess would turn three choices into a coin toss.
- **Match confirmed, approve refused** (a file trashed meanwhile, a file disabled, a rate limit): the phone goes to the chooser (3.4) with a toast "A File Couldn't Be Added" / "Lecture 5.pptx is no longer in your library." (or the rate limit's "Too Many Changes Right Now" / "Wait a minute, then try again."). Never a dead end: the match stands, so choosing again needs no new scan.
- **Offline at the tap:** the choice returns to rest, toast "You're Offline" / "Check your connection, then tap the number again." The code may still be alive; if it expired meanwhile, the next tap answers expired.

### 3.4 Match with nothing packed, and Change Files

Nothing in Up Next: the match pick comes first, alone under the title and the line "Tap the screen's number, then choose your files." After the right number, the chooser opens: today's choose state (design.md section 7) with checkboxes (a live library approves up to 12, so the rows are checkboxes, not radios), Up Next files on top and ticked, then the newest ready files (`GET /api/files`, at most 50), and Cancel then Approve. Approve carries no digits here: the match is already done. Two taps from the match. Ticks made here are saved to Up Next as they are made (the same PATCH as the library), so the pack after the talk is what was presented, and the next talk's stale-pack line (3.2) reads true. Unfinished uploads are not listed (section 1).

Change Files (before the tap) opens the same chooser over the match state, as a full page state with Back to the match: changes edit Up Next itself (one model, library.md), and Done returns to the match pick with the new rows. Its list comes from the user's own library (`GET /api/library`, cookie), so it needs no confirmed match.

### 3.5 Approved (live, library items)

```
390                                          1440 (two columns, as /a's desktop)

  Approved for Room 2.14                       Approved for Room 2.14        +--------------------+
  Ends in 59:12 >                              Ends in 59:12 >               | +--+ Lecture 5.pptx|
                                                                             |      On the Screen |
  +------------------------------------+       Notes                        | +--+ Reading list  |
  | +--+ Lecture 5.pptx    On the Screen|       +------------------------+  +--------------------+
  | +--+ Reading list.pdf               |       | Ask who has read ch. 2 |
  +------------------------------------+       | before the break.      |
                                               +------------------------+
  Notes                                         [! Revoke !]
  +------------------------------------+
  | Ask who has read chapter 2 before  |
  | the break.                         |
  |                                    |
  +------------------------------------+
.--------------------------------------.
| [!            Revoke            !]   |
'--------------------------------------'
```

- Title "Approved for Room 2.14", "Ends in 59:12" with its chevron (opens Session Expiry, as today), the approved items read only. The item on the screen carries "On the Screen" in its line 2 (13 `--muted`), since a live screen can now hold several.
- **Notes** (lazy, fetched when an approved item has notes; `GET /api/notes?item=`, pid only): design.md section 7 (Phone page, Presenter's notes) owns the box. It follows the screen's page, instantly, with no "Slide n" label; a page with no note keeps the box and shows the pill "No Notes for This Slide"; a deck with none has no box.
  - When PowerPoint presents it, bloop cannot see the page: the box lists every slide's notes in order, each under its "Slide n" label, scrollable inside the page (README.md decision 7).
- **Open in PowerPoint and Show Slides Here** sit on this state for the deck on the screen, in the action panel above Revoke as one row of two secondaries, on the same channel as Revoke (a phone command the screen follows, as Revoke ends it). Show Slides Here reads "Preparing Slides", disabled, until `derivedReady`, and enables in place (viewers.md section 4). The one that matches what the screen shows is hidden (bloop's viewer on: only Open in PowerPoint). Fallback if P1 can't carry them: the phone shows the line "Choose on the screen how to open it." and the choice stays on the PC alone (viewers.md section 4), as decision 10 falls back.
- Revoke (rose) asks "End This Session?" as today.
- Focus after approval: the title.

## 4. Present Live started from the landing on the room PC

The landing's Present Live is a link to `/s` (live). The PC shows the waiting screen with its QR (design.md section 7). Nothing about it is new except that open mode makes it a front-door button; the phone's side is section 3.

## 5. Signed out: the early-access state, and resume

Open mode only. The claim answers `auth_required` before spending the code, so the code is still alive.

```
390 (all four in the glass panel, stacked)       1440 and 844 x 390 (two rows: four do not fit 480)

  <Back
                                                       Early Access Only
  Early Access Only                                    Sign in to present your own files.
  Sign in to present your own files.                   No invite yet? You can still send
  No invite yet? You can still send one                one file to this screen.
  file to this screen.
                                                       ( Try the Demo ) ( Join the Waitlist )
                                                       [ Send One File ] [[ Sign In ]]
.--------------------------------------.
| [[             Sign In            ]] |
| [          Send One File         ]   |
|          ( Join the Waitlist )       |
|            ( Try the Demo )          |
'--------------------------------------'
```

- Title "Early Access Only"; line "Sign in to present your own files. No invite yet? You can still send one file to this screen." (owner's choice: it leads with what a signed-out member does, and the second sentence tells a guest the way on.)
- Actions, in the action row (from 640 wide, four wrap to two: the text pair over the buttons): Try the Demo (text, `/demo`), Join the Waitlist (text, the Tally link, `source=phone`, `data-waitlist`), Send One File (secondary; the guest path, today's guest add state, with the same code), Sign In (primary).
- Focus: the title, then Try the Demo, Join the Waitlist, Send One File, Sign In (reading order, the primary last as in every state; stacked, the panel puts Sign In on top).
- Lazy: `core/early.js` loads on `auth_required`, with `GET /api/me` asked beside it; the state shows only when that answers `launchMode: "open"`. If the module cannot load, the code goes the guest way.
- Preview mode (or `/api/me` failed): there is no early-access state; the phone claims the same code as a guest at once (one more claim; the refused one spent nothing).

### 5.1 Sign In, then resume

Sign In keeps the code, its `Idempotency-Key` and the time in `sessionStorage` (`bloop.resume`) and goes to `/auth/start`, which takes no parameters; `/auth/callback` always lands on `/a` with no code, so `/a` takes the kept code (once: read and dropped; `core/boot-code.js`, on first load, so a failed lazy load never loses it) and claims it again as the owner, with the same key.

- **Code still alive** (a passkey sign-in takes seconds): the match pick, as section 3. The lecturer never sees the camera again.
- **Code expired** (the claim answers `code_expired` for the 5 minutes the screen keeps a dead code routing, `code_unknown` after; an email code usually takes longer than the code's life): title "Scan the Screen Again"; line "The code changed while you signed in. You're signed in now, so one scan is all it takes." when `/api/me` says signed in, otherwise (the sign-in failed or `/api/me` gave no answer) "The code on the screen changed while you were away. One scan picks it up again."; button Enter the Code (primary). No Back: one exit.
- **Still signed out, code alive**: the claim answers `auth_required` again, so the early-access state again.
- **Taken meanwhile** (someone else scanned): as today's taken state.
- The stored code is taken on the next load of `/a` whatever follows, dropped by a new scan, and ignored after 5 minutes unused, so a later visit to `/a` never replays it.
- Why tell the truth about the time: a code lives about a minute (design.md section 10), and an email round trip is longer; saying "one scan is all it takes" turns the miss into a promise the next scan keeps.

## 6. Strings (this file)

| Slot | String |
|---|---|
| library group | Up Next; All Files |
| clear | Clear; toast Up Next Cleared / Undo |
| full | toast Up Next Is Full / A talk takes up to 12 files. Untick one first. |
| Present button | Present |
| Present sheet | Present on a Screen / Open bloop.here/s on the room PC, then scan its code with your camera. / Opens first: {name} / Choose your files after you scan. / {name} is still uploading. Keep this page open until it says Saved. / buttons Done, Enter the Code |
| match legend | Tap the Screen's Number; while sending: Approving...; after 4 s: Still approving. Keep this page open. |
| stale pack | Last Presented 18 Nov; Last Presented Today 10:02; Use {name} Instead |
| match, nothing packed | line: Tap the screen's number, then choose your files. |
| more rows | +3 More Files |
| change | Change Files |
| scope | Only these files go to the screen. The screen never gets your account. `[V-4]` |
| wrong number | That Wasn't the Screen's Number / Scan the screen again, or type its code. / Enter the Code |
| approve refused | toast A File Couldn't Be Added / {name} is no longer in your library. |
| match module failed | Match Didn't Load / Reload |
| approved | Approved for Room 2.14; On the Screen; Notes; No Notes for This Slide; Open in PowerPoint; Show Slides Here; Preparing Slides; fallback line: Choose on the screen how to open it. |
| early access | Early Access Only / Sign in to present your own files. No invite yet? You can still send one file to this screen. / Sign In, Send One File, Try the Demo, Join the Waitlist |
| resume, expired | Scan the Screen Again / The code changed while you signed in. You're signed in now, so one scan is all it takes. (signed out: The code on the screen changed while you were away. One scan picks it up again.) / Enter the Code |

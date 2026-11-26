# The room screen with library files: viewers, the choice sheet, the honesty toast

`/s` in live mode once a signed-in phone approves library files (present-live.md). The viewer layout, the control pill, presenting and the sidebar are design.md section 7 (Screen page) as built for the demo; this file adds what live library files need. The screen never shows notes, an account or an email.

## 1. What opens first

- One approved file: it opens as its kind says (section 2). Several: the viewer with its list (the left rail from 760, the bottom sheet under it), in Up Next order, and the first file opens by itself (README.md decision 6); the rest wait.
- **A deck** (pptx, ppt, odp; the list is the converter's, docs owned by V2): PowerPoint first. Under 30 MB the screen runs today's launch ladder (design.md section 7: "Opening in PowerPoint", then "Open in PowerPoint" or the fallbacks), with the deck's slides already in bloop's viewer behind it, so Show Slides Here is instant if PowerPoint fails. Over 30 MB: the choice sheet (section 4).
- **Anything else** opens in bloop's viewer at once.

## 2. Viewers (each a lazy module, fetched with the first item of its kind)

| Kind | Viewer | Stage | Honesty toast |
|---|---|---|---|
| deck shown in bloop | slides: the converter's slide images, 1920 or 3840 wide by the screen's size and DPR | one slide at a time, as the demo deck | yes (section 5) |
| PDF | pdf.js, self-hosted worker | wide pages step one at a time; tall pages scroll as one column | no (it is the file itself) |
| document (docx, doc, odt, rtf) | pdf.js on the converter's PDF | as a portrait PDF | yes: "Showing a Copy as PDF" |
| spreadsheet (xlsx, xls, ods, csv) | sheet: values in a table, capped | a white card filling the stage, sheet tabs at its foot | yes: "Showing Values Only" |
| text (md, txt) | text: markdown rendered to DOM, txt preformatted | a white card, 860 max, scrolling | no |
| photo, video | as today (design.md section 7) | as today | no |

### 2.1 Slides (deck shown in bloop)

```
1440 x 900, two items, the first a deck in bloop's viewer

 [b bloop]
 .-----------------------.  +-------------------------------------------------------------+
 | +--+ Lecture 5.pptx   |  |                                                             |
 | |PP| PowerPoint 18 MB |  |                      slide 3 (the frame)                    |
 | +--+ Reading list.pdf |  |                                                             |
 '-----------------------'  +-------------------------------------------------------------+
                        .-----------------------------------------------------------.
                        | 3 / 24  [ Open in PowerPoint ]  [ Present ]  [[ Download ]] |
                        '-----------------------------------------------------------'
 [! End !]                                                               ( Report )
```

- The control pill gains Open in PowerPoint (secondary, before Present) for a deck shown in bloop: the way back to full fidelity is one click on the PC, where the honesty toast says it.
- Pages step as the demo deck: halves are Previous and Next, keys, swipe; 3840 images only on a 4K screen (`devicePixelRatio` times width over 2400).
- Slide images load in order from the current slide outward (next 2 ahead, 1 behind), each through the loader until decoded; a step to a slide not yet loaded shows its loader over the 480 thumbnail, never a blank.

No 390 or 844x390 mockup: a live screen under 600 wide shows "Use the Room's Screen" and starts nothing (design.md section 7), so a live viewer never runs at phone size. At 834 the list is the bottom sheet, as the demo's.

### 2.2 Sheet

```
1440, a spreadsheet item

 +---------------------------------------------------------------------------------+
 |       A            B           C           D                                    |  header row sticky
 |  1  Name         Score       Grade                                              |
 |  2  Asha         72          B                                                  |
 |  3  ...                                                                         |
 |                                                                                 |
 | [ Results ] [ Summary ] [ Raw ]                                    Rows 1 to 100 |  sheet tabs, segmented
 +---------------------------------------------------------------------------------+
```

- A white `--r-list` card filling the stage, 17 px cells (read from the room), tabular figures, row and column heads 14/600 `--muted` on `--paper`, a `--hairline` grid. Scrolls in both directions inside the card; arrow keys scroll.
- Values only: formulas show their last saved value; charts, images, comments and formatting are not shown (the honesty toast says so). Capped rows and columns: the foot says "Rows 1 to 100 of 2,400" and the toast adds "Download it to see every row."
- Sheet tabs: the segmented tabs (README.md additions), shown only with 2 or more sheets.
- The parse runs in a Worker; until it answers, the loader holds the card (indeterminate). Over 10 s: the line "Still reading Results.xlsx." under it; the cap means it ends.

### 2.3 Text

Markdown: headings at the doc page sizes (h1 30, h2 24), body 20/1.5 for the room, 860 max, `--ink-2`, links shown as text with their host (never clickable on a room screen: a click would leave the session's page). Plain text: Inter 20 with `white-space: pre-wrap` and tabular figures, never `--mono`, which is the match number's alone (design.md section 4). CSV goes to the sheet viewer.

## 3. Loading on the screen

- The stage's loader holds the item's box at the frame's ratio until its first page decodes (design.md section 6), never a spinner on black.
- **Slow** (over 3 s without the first page): the loader stays and the stage's line, under the frame, says "Loading Lecture 5.pptx." (`--muted` 19). Over 15 s: "This is taking a while. The phone can end it any time." and the control pill's Download stays usable, since a download may be faster than many images.
- **File origin unreachable** (the workers.dev probe fails within 2.5 s): links come from bloop.here instead (FO-01); no string changes, only a slower first page.

## 4. The over-30 MB choice sheet

Shown on the screen when the item to open is a deck over 30 MB, because PowerPoint would download it first and the room waits.

```
1440, over the waiting viewer (stage dimmed by the backdrop)

                 .----------------------------------------------.
                 |  Lecture 5.pptx Is 88 MB                     |   22/600
                 |  PowerPoint downloads it to this PC first,   |   --muted 17
                 |  which can take a while here.                |
                 |                                              |
                 |  [[ Open in PowerPoint ]]                    |
                 |  [ Show Slides Here ]                        |
                 |  ( Download )                                |
                 '----------------------------------------------'
```

- The `.leave` card (design.md section 7, Screen page: a popover card, centered, `--r-stage`), with three actions stacked in one column, 8 apart: Open in PowerPoint (primary; PowerPoint first stays the house rule), Show Slides Here (secondary), Download (text; a native attachment navigation, so the bytes are fetched once, by the browser).
- Title "Lecture 5.pptx Is 88 MB" (the name middle-ellipsized to keep 5 words of weight; the size from the file). Line "PowerPoint downloads it to this PC first, which can take a while here."
- Show Slides Here opens the slides viewer with the honesty toast. Open in PowerPoint runs the launch ladder. Escape or a click outside: nothing opens; the viewer shows the deck's card with the same three actions in its pill, so the choice is never lost.
- **Slides not ready yet** (the converter still running): Show Slides Here is disabled and reads "Preparing Slides", with the loader's sheen across it; on `derivedReady` it enables in place and reads "Show Slides Here", with no move, no reflow and no focus change (the label's width is held at the wider of the two). The same rule holds wherever the button appears: the deck's pill and the phone.
- Focus: Open in PowerPoint on open (a projector's keyboard user lands on the house default); Tab order is the stack.
- **The phone can choose too.** The approved state on the phone holds Open in PowerPoint and Show Slides Here for the deck on the screen (present-live.md 3.5), sent on the same channel as Revoke; a choice made on either side closes the sheet on the screen. While the sheet is open the phone's line reads "The screen asks how to open Lecture 5.pptx." above the two buttons. Fallback if P1 cannot carry the command: the phone shows only that line (and "Choose on the screen how to open it." once the sheet is dismissed), and the choice stays on the PC, as above.
- Lazy: the sheet's module loads with the first item over 30 MB; fallback: the deck's card with the three actions in the pill.

## 5. The honesty toast

Whenever bloop's own viewer shows a converted file, the screen says once what does not carry over. The screen toast (README.md additions): bottom center at `--inset`, above the control pill when they would meet, `role="status"`, 8 s or a click, hidden while presenting and never shown again for that item in this session.

```
1440, bottom center of the stage

            .------------------------------------------------------------.
            | Showing Slides in bloop                                    |
            | Animations, videos and transitions won't play. Open in     |
            | PowerPoint for the full deck.                              |
            '------------------------------------------------------------'
```

| Kind | Title | Line |
|---|---|---|
| deck | Showing Slides in bloop | Animations, videos and transitions won't play. Open in PowerPoint for the full deck. |
| deck, PowerPoint failed first | PowerPoint Didn't Open | Showing the slides in bloop instead. Animations, videos and transitions won't play. |
| document | Showing a Copy as PDF | The layout can differ a little from the original. |
| spreadsheet | Showing Values Only | Formulas, charts and formatting aren't shown. Download it to see everything. |
| deck with fonts missing | (no extra toast) | the warning lives on the phone and in the library, never on the room's wall |

- Why a toast and not a banner: it is information for the presenter at the moment they see the stage, and a resting banner would sit on every slide of the talk.
- Present starts: the toast hides at once (the room sees slides, not apologies).

## 6. The receiving pill (a guest's upload)

On a live screen whose guest is sending, the claimed screen's QR card holds the match number as today; under the room name, the upload pill's face appears read only: "Receiving Talk.pptx" / "34 of 88 MB", then "Checking the File", then the guest offer state (design.md section 7, "Sent by a Guest"). It is the upload pill part without Close (only the guest can cancel), centered in the hint's place, so nothing moves. `role="status"` announces only "Receiving Talk.pptx" and the offer.

```
1440, wide waiting layout, a guest sending

  +------------------+     Room 2.14
  |                  |
  |       42         |     .------------------------------.
  |                  |     | +--+ Receiving Talk.pptx     |
  +------------------+     | |PP| 34 of 88 MB             |
                           '------------------------------'
```

Upload paused on the phone (offline): "Waiting for the Phone" in the line, no sheen. Canceled: the pill leaves and the screen shows its code again, as a cancel does today.

## 7. Report

- A text link "Report" (14 `--muted`, 44 hit area) at the bottom right of a live viewer, in the footer line's row, for any library or guest file on the stage. Hidden while presenting. Never on the demo.
- It opens `/report` in a new tab on the PC, prefilled with the screen's channel only (the server maps it to file ids; the page never sees an id or a name). The screen stays as it was.
- Why on the screen: the person most likely to report a file is someone in the room who is not its owner.
- **Both modes.** `/report` is public in preview and open (README.md, Mode). The link shows only where a report can reach a file: on a live screen whose stage holds a guest's or a library file the server can map from the screen's channel. In preview that is a live screen with a guest's file (and a tester's library file); the demo never shows it, in either mode, since its files are bloop's own. A screen that cannot map its channel (no file on the stage, a parked or ended screen) shows no link rather than one that leads to a form that cannot name the file.

## 8. States and transitions

| From | To | How it looks |
|---|---|---|
| claimed (number in the QR card) | approved, opening | the house scene change (380 ms rise); the first item's loader at once |
| one item | the phone revokes | Session Ended, as today |
| deck in PowerPoint | PowerPoint fails | the PDF fallback rule is replaced: slides in bloop with the "PowerPoint Didn't Open" toast |
| slides showing | the file is trashed or disabled mid talk | the next image fetch is refused; the stage keeps the slides already drawn until a step needs a new one, then shows the file card "This File Isn't Available Anymore" / "Its owner removed it, or it was disabled." |
| any | offline | parked, as today (design.md section 7, Busy states) |

## 9. Strings (this file)

Open in PowerPoint; Show Slides Here; Preparing Slides (the disabled Show Slides Here); Choose on the screen how to open it. (phone, fallback); Download; Report; {name} Is 88 MB / PowerPoint downloads it to this PC first, which can take a while here.; The screen asks how to open {name}. (phone); Loading {name}.; This is taking a while. The phone can end it any time.; Still reading {name}.; Rows 1 to 100 of 2,400; Download it to see every row.; Receiving {name}; Checking the File; Waiting for the Phone; This File Isn't Available Anymore / Its owner removed it, or it was disabled.; the toast rows in section 5.

# Library (`/library`)

The signed-in user's files: add, see what is ready, pack Up Next, rename, trash, preview, and start a talk. Mobile first; the desktop is where most packing happens, so it gets the room to show Up Next beside the list. Upload progress is upload.md; packing and Present are present-live.md.

## 1. Frame

- App page (README.md, Shared rules). Corner bar: top left the logo button (the house frame with the mark and bloop, to `/`); top right Account (the house frame square, Lucide `circle-user`, named "Account", to `/account`).
- Title "Library" (34/600, -0.035em, left, `/a`'s room title size), then the quota line.
- The list is the item row in a `--r-list` box (design.md section 6), the phone's own list face.
- Bottom action panel (phone) holds Add Files (secondary) and Present (primary), side by side even under 640: two short labels fit at 320 (each about 130 wide), and both are the page's main actions, so neither belongs in a menu. Present is the primary because it is the thing the library is for.

## 2. Phone (390)

```
390 x 844

  [b bloop]                         [(user)]    corner bar: logo button, Account

  Library                                       title
  1.2 of 5 GB used                              quota line, 13 --muted tabular
  [#######.............................]       quota bar: 4 px, --g1 track, --ink fill, pill ends

  Up Next                          ( Clear )    group label 14/600 --muted; Clear text button
  +------------------------------------------+
  | +--+ Lecture 5.pptx               [x] (.) |  row: tile, name, line 2, tick, More
  | |PP| PowerPoint · 18 MB · Edited today   |
  | +--+ Reading list.pdf             [x] (.) |
  | |PD| PDF · 2 MB                          |
  +------------------------------------------+

  All Files                          ( Sort )   group label; Sort text button with arrow-up-down
  +------------------------------------------+
  | +--+ Lecture 6.pptx               [ ] (.) |
  | |PP| PowerPoint · 22 MB  (Preparing Slides)|  amber status chip in line 2
  | +--+ Seminar.docx                 [ ] (.) |
  | |DC| Word document · 1 MB                |
  | +--+ Results.xlsx                 [ ] (.) |
  | |XL| Excel spreadsheet · 340 KB          |
  | +--+ Macro deck.pptm                  (.) |  refused: no tick
  | |PP| (Can't Show Slides) This file has macros. |
  +------------------------------------------+
  ( Trash · 3 )                                 text button, only when the trash has files

.--------------------------------------------.
| [ Add Files ]          [[ Present ]]       |  bottom action panel, glass
'--------------------------------------------'
```

- **Row** (the item row, design.md section 6): the 40 px tile (the slide 1 thumbnail once prepared, contained; else the kind glyph: `presentation`, `file-text`, `file-spreadsheet`, `image`, `film`), the name (15/600, middle ellipsis keeps the extension), line 2 (13 `--muted` tabular): kind · size · the date ("Edited today", "Edited 3 Nov", "Presented 10:02" when it was the last thing done). Then the tick (a checkbox, the row's trailing Lucide `check` inside a 44 px hit area: ink check on, an empty `--g2` ring off) and More (Lucide `ellipsis`, 44 square, "More for Lecture 5.pptx").
- **Row tap** (anywhere but the tick or More) opens the preview (section 5). Rows are buttons; the tick and More are their own controls beside it, never nested.
- **No tick until Saved.** A row whose upload is still running or checking has no tick (the slot stays empty, so the name never shifts when it appears), and More holds only Cancel Upload. The tick appears in place when the pill says Saved. So Up Next, the match state and the chooser never hold an unfinished upload (present-live.md section 1), and the Saved pill offers the one shortcut, Add to Up Next (upload.md section 2).
- **Status in line 2** (README.md additions, status chip on a row):
  - "Preparing Slides" (amber chip): converting. The rest of the row works; it opens in PowerPoint meanwhile.
  - "Can't Show Slides" (rose chip) then the reason, one sentence: "This file has macros.", "This file is password protected.", "This file is damaged.", "This file type can't be shown in bloop." It can still open in PowerPoint if the type allows; a refused upload (failed validation) never reaches the list (upload.md).
  - "Missing 2 Fonts" with a 16 px `triangle-alert` (no chip; it is a note, not a state): tap the row, and the preview names them (section 5).
  - A disabled file (admin): rose chip "Unavailable" and "This file was disabled after a report." No tick, no preview; More holds Delete only.
- **Sort** (lazy): a menu sheet (the Session Expiry sheet's bubble) with three radio rows: Newest First (default), Name, Size. Remembered per device (`localStorage`).
- **Order:** Up Next in Up Next order; All Files by the sort. All Files lists every file, Up Next ones too (ticked), so ticking several never moves a row from under the thumb; Up Next repeats them at the top. The phone mockup above leaves the repeats out to save lines. On a desktop Up Next is its own card, so the same rule holds.
- **Long names:** the middle ellipsis; `minmax(0, 1fr)` columns (lessons: a grid list grows to a long name otherwise). A stored name is at most 200 code points (`NAME_MAX`, `shared/names.js`); the shots walk a 200 code point name.

### 2.1 Phone on its side (844x390)

```
844 x 390

 [b bloop]                                                              [(user)]
 Library                         | Up Next                         ( Clear )
 1.2 of 5 GB used                | +--+ Lecture 5.pptx                [x] (.)
 [#####........]                 | +--+ Reading list.pdf              [x] (.)
                                 | All Files                        ( Sort )
 ( Trash · 3 )                   | +--+ Lecture 6.pptx                [ ] (.)
.-------------------------------------------------------------------------------.
| [ Add Files ]                                             [[ Present ]]        |
'-------------------------------------------------------------------------------'
```

Two columns, as `/a` on its side: the title, quota and Trash on the left (fixed), the list on the right scrolling inside its own card (`overscroll-behavior:contain`); the panel one button tall, `--inset` above the foot.

## 3. Desktop (1440)

```
1440 x 900

 [b bloop]                                                                       [(user)]

            Library                                   [ Add Files ]
            1.2 of 5 GB used [#######...........]

            +----------------------------------------------------+   .-----------------------------.
            | All Files                                 ( Sort ) |   | Up Next             ( Clear )|
            | +--+ Lecture 6.pptx        PowerPoint  22 MB   [ ] (.)| | 1 +--+ Lecture 5.pptx    [x] |
            | |PP| Edited today          (Preparing Slides)      | |   | 2 +--+ Reading list.pdf  [x] |
            | +--+ Seminar.docx          Word        1 MB    [ ] (.)| |                              |
            | +--+ Results.xlsx          Excel       340 KB  [ ] (.)| | Opens First: Lecture 5.pptx |
            | +--+ Dog.jpg               JPEG image  3 MB    [ ] (.)| | [[ Present ]]               |
            |                                                    |   '-----------------------------'
            | ( Trash · 3 )                                      |
            +----------------------------------------------------+
```

- Content max 1136, two columns: the list (fluid) and Up Next (`--side`, 280, the viewer sidebar's width), gap 24. Up Next is a glass card (the viewer sidebar's recipe) and sticks 24 under the top while the list scrolls.
- Rows keep the two-line face (design.md: kind and size fold into line 2 under 600 px); from 1024 the list shows kind, size and date as aligned columns inside the row, since there is room and a desk is where people compare files. Same row part; the columns are a wider layout of line 2, not a table.
- Up Next shows the order numbers (14/600 `--muted` tabular) and the first file's name; Present here opens the Present sheet as on the phone.
- Add Files sits by the title (secondary); Present lives in Up Next. No bottom panel on a desktop.
- **Drag and drop** anywhere on the page: `core/drag.js`'s hint ("Drop Files to Add Them", the plural of `/a`'s), then the upload pill. A folder drop: toast "Folders Can't Be Added" / "Drop the files inside it instead."
- **Keyboard:** Tab reaches Add Files, Sort, then each row's button, tick and More in order, then Up Next's rows, Clear, Present. Space toggles a focused tick. Delete on a focused row opens its Move to Trash (with undo, so no question).
- 834 (tablet): one column, Up Next as the top group (the phone layout at a wider column), the panel stays at the foot under 900 wide.

## 4. Row menu: Rename, Download, Move to Trash

More opens a menu sheet (the Session Expiry sheet's bubble, rows 52 tall, a quiet icon on each: `pencil`, `download`, `trash-2`):

```
390                                        1440: the same rows as a popover anchored to More
.--------------------------------------.
| Lecture 5.pptx                   (x) |   title: the file name, 17/600, middle ellipsis
| (pencil)   Rename                    |
| (download) Download                  |
| (trash)    Move to Trash             |   --rose-ink text: the one destructive row
'--------------------------------------'
```

- **Move Up, Move Down** (Lucide `arrow-up`, `arrow-down`): on an Up Next row only, first in the menu, on the phone as on the desktop, so reordering never needs a drag. Hidden at either end (no Move Up on the first). The menu stays open after a move, so several steps are several taps, and the row moves in Up Next behind the sheet at once.
- **Rename:** the menu becomes a field (52 tall, `--r-pill`, the name selected without its extension) with Save (primary). Enter saves, Escape cancels. The extension cannot be changed (it is the file's type); typing one is kept as part of the name. Empty name: Save disabled. Same name as another file: allowed (files are ids, not names). Saved: the row updates in place, no toast.
- **Download:** the original, as a native attachment (`/p/` asset `original`): no page change, the browser's own download UI.
- **Move to Trash:** at once, with the undo toast (README.md additions): "Moved to Trash" / "Undo". The row leaves the list instantly (no collapse animation: lists change instantly in bloop). If it was in Up Next, it leaves Up Next too, and Undo puts it back in its place.
- A file on a live screen right now: Move to Trash still works and its screen link stops at the next fetch (LIB re-check at fetch time); the toast says "Moved to Trash" / "It also left Room 2.14." with Undo.

## 5. Preview

Row tap opens a full-screen sheet (phone: the viewer's bottom sheet at full height, `max-height:100dvh` with the grab bar; desktop: a centered `--r-stage` panel over a `--ink` .24 scrim, max 1040 by the window's height less 2 `--inset`). The preview module and a `/p/` preview link (5 minutes) are fetched on the row's pointerdown, so the first slide is usually already on its way at the tap.

```
390                                         1440
.--------------------------------------.    .------------------------------------------------.
|  ===                             (x) |    | Lecture 5.pptx                             (x) |
|  Lecture 5.pptx                      |    | PowerPoint · 18 MB · 24 slides                 |
|  PowerPoint · 18 MB · 24 slides      |    | +--------------------------------------------+ |
| +----------------------------------+ |    | |                                            | |
| |                                  | |    | |              slide 1 (the frame)           | |
| |          slide 1 (frame)         | |    | |                                            | |
| +----------------------------------+ |    | +--------------------------------------------+ |
|            1 / 24                    |    |   1 / 24                                       |
| (tri) Aptos and Grandview aren't on  |    | (tri) Aptos and Grandview aren't on bloop...   |
| bloop's slides, so a close match is  |    | [ Download ]  [ Rename ]     [[ Add to Up Next ]]|
| used. PowerPoint on the room PC may  |    '------------------------------------------------'
| have them.                           |
| [ Download ]     [[ Add to Up Next ]]|
'--------------------------------------'
```

- Deck, PDF, doc: the slides or pages from the converter's outputs (slide WebP at 1920 on a desktop, 480 for the strip, chosen by width), stepping as the viewer does (halves are Previous and Next; swipe over 50 px). Image: the picture. Video: native controls, as the screen's video. Sheet: the first 100 rows, values only. Text: rendered (viewers.md).
- **Font warning** (`fonts_missing`): one `--ink` 600 sentence with `triangle-alert`, no tint (design.md's warn card): "Aptos and Grandview aren't on bloop's slides, so a close match is used. PowerPoint on the room PC may have them." One font: "Aptos isn't on bloop's slides...". More than 3: "4 fonts aren't on bloop's slides...". Shown here and once as a toast when the upload finishes (upload.md), never on the room screen.
- **Preparing:** the loader over the tile's thumbnail where the first slide will be, indeterminate, with the line "Preparing slides. You can still present it in PowerPoint." (`--muted`). It turns into the slides when the library socket says `derivedReady`, without closing the sheet.
- **Can't show:** the file card (design.md: type tile, kind and size) and the reason sentence; Download stays.
- Actions: Download (secondary), Add to Up Next or Remove from Up Next (primary; it is the tick, said in words), Rename on a desktop. Under 640 the two sit in one row at the sheet's foot.
- Focus: the title on open; Escape, the grab bar, Close or the backdrop close it, and focus returns to the row.
- The preview link is good for 5 minutes; a preview left open longer refreshes its link on the next page step, silently. A refused refresh (the file was trashed elsewhere): the sheet closes with toast "This File Was Moved to Trash".

## 6. Trash

"Trash · 3" (the count tabular) under the list opens the trash view in place: title "Trash", line "Files here are deleted for good after 30 days." (the number from the API), Back returns to Library.

- Rows: the item row with line 2 "Deletes in 29 days" (`--muted`; under 3 days `--rose-ink`: "Deletes tomorrow"). No tick. More holds Restore and Delete Now.
- Restore: at once, toast "Restored" (no undo needed: trash is the undo). Delete Now asks first in the `.leave` card: "Delete Lecture 5.pptx?" / "This can't be undone." / Cancel, Delete (rose).
- Empty Trash (text button by the title, `--rose-ink`): the same card, "Empty the Trash?" / "3 files are deleted for good. This can't be undone." / Cancel, Empty Trash (rose).
- Trash counts toward the quota until deleted: the quota line in the trash view says "Trash uses 240 MB of your 5 GB." so emptying it reads as the way to get room.
- Empty trash view: "The Trash Is Empty" / "Files you delete stay here for 30 days." and Back.

## 7. Quota

- The quota line and bar sit under the title: "1.2 of 5 GB used" (one decimal under 10 GB, MB under 1 GB: "340 MB of 5 GB used"). From 90 percent the bar's fill and the line turn `--robin-ink` ("4.6 of 5 GB used. Delete files or empty the trash to add more.") A full library: "5 of 5 GB used. Delete files or empty the trash to add more." and Add Files stays enabled (a tap explains, upload.md refusals), since a disabled button explains nothing.
- The bar is a `progressbar` named "Storage used", `aria-valuenow` in whole percent.
- Uploads in flight reserve their bytes (quota is reserved at create): the bar shows used plus reserved, the reserved part as `--g2`, so the bar never jumps backward when an upload fails.

## 8. Empty library (first visit)

```
390                                          1440 (one column, centered, max 560)

  [b bloop]                       [(user)]

  Library                                     Library
  0 of 5 GB used                              0 of 5 GB used

        +--------------------------+                +--------------------------+
        |   (upload, 28, glass)    |                |   (upload, 28, glass)    |
        +--------------------------+                +--------------------------+
        Add Your First File                         Add Your First File
        Decks, PDFs, documents,                     Decks, PDFs, documents, spreadsheets,
        spreadsheets, photos and videos.            photos and videos. Files stay yours:
        Files stay yours: stored in the EU,         stored in the EU, deleted when you say.
        deleted when you say.
                                                    [ Add the Sample Deck ]  [[ Add Files ]]
.--------------------------------------.
| [[           Add Files            ]] |
| [       Add the Sample Deck       ]  |
'--------------------------------------'
```

- The features band's tile (design.md section 6, Features grid: a 56 px glass tile with a 28 px glyph on the warm backdrop band) with Lucide `upload`, then "Add Your First File" (22/600), the line, and two actions: Add Files (primary here: nothing to present yet) and Add the Sample Deck (secondary; copies the demo's deck into the library, already prepared, so the first Present can be tried at once).
- Present is absent while the library is empty (a state with nothing to present has no Present).
- Once one file exists the page takes its normal layout; the sample deck is a normal file the user can delete.

## 9. States and transitions (summary; full list in states.md)

| State | What shows |
|---|---|
| loading (first paint, no cache) | title and quota line as skeleton bars, 4 skeleton rows; the panel's buttons present but Present disabled until the list arrives |
| loaded from cache | the last list from `sessionStorage`, then the fresh one replaces it in place (no flash), so Back from the preview never shows a skeleton |
| uploading | the new row at the top of All Files with the loader over its tile and no tick until Saved, and the upload pill (upload.md) |
| preparing | the amber chip; the socket updates it; no socket (blocked): poll every 10 s while any row is preparing, stop when none is |
| offline | toast "You're Offline" / "Your library will update when you're back."; the list stays usable read only; ticks and renames queue nowhere: they are refused with the same toast, so nothing changes silently later |
| signed out (cookie expired) | open: `/signin?next=/library`, then back here; preview: the 404 page (README.md, Mode) |
| suspended account | the page shows "Your Account Is Suspended" / "You can still download your files. Email hi@bloop.here to appeal." with Download All (`/api/me/export.zip`) |
| deletion scheduled | a card above the list: "Your account is deleted on 2 Dec." / "Cancel Deletion" (primary, `POST /api/me/restore`) |

## 10. Lazy modules (by intent)

| Module | Fetched on |
|---|---|
| upload (and the pill) | pointerdown or focus on Add Files or Add the Sample Deck; the first file drag |
| row menu, rename, trash | pointerdown or focus on any More; the Trash link |
| sort | pointerdown or focus on Sort |
| preview and its viewers | pointerdown on a row (the viewer of that file's kind only) |
| Present sheet | pointerdown or focus on Present |
| library socket | the list holding a row that is uploading or preparing |

Fallbacks: a failed menu import shows toast "That Didn't Load" / "Reload the page, then try again." with Reload; a failed preview opens the original by download; a failed upload module is upload.md's.

## 11. Strings (this file)

| Slot | String |
|---|---|
| title, quota | Library; 1.2 of 5 GB used; 340 MB of 5 GB used; at 90 percent: 4.6 of 5 GB used. Delete files or empty the trash to add more. |
| groups | Up Next; All Files |
| row line 2 | PowerPoint · 18 MB · Edited today; Presented 10:02 |
| chips | Preparing Slides; Can't Show Slides; Unavailable; Missing 2 Fonts |
| reasons | This file has macros.; This file is password protected.; This file is damaged.; This file type can't be shown in bloop.; This file was disabled after a report. |
| controls | Add Files; Present; Sort; Newest First; Name; Size; More for {name}; Rename; Download; Move to Trash; Save; Move Up; Move Down; Cancel Upload |
| toasts | Moved to Trash / Undo; It also left Room 2.14.; Restored; Folders Can't Be Added / Drop the files inside it instead.; This File Was Moved to Trash; That Didn't Load / Reload the page, then try again. / Reload |
| drop hint | Drop Files to Add Them |
| preview | 24 slides; 1 / 24; Add to Up Next; Remove from Up Next; Preparing slides. You can still present it in PowerPoint. |
| fonts | {Font} isn't on bloop's slides, so a close match is used. PowerPoint on the room PC may have it.; {A} and {B} aren't on bloop's slides, so a close match is used. PowerPoint on the room PC may have them.; 4 fonts aren't on bloop's slides... (same sentence) |
| trash | Trash · 3; Trash; Files here are deleted for good after 30 days.; Deletes in 29 days; Deletes tomorrow; Restore; Delete Now; Delete {name}? / This can't be undone. / Delete; Empty Trash; Empty the Trash? / 3 files are deleted for good. This can't be undone.; Trash uses 240 MB of your 5 GB.; The Trash Is Empty / Files you delete stay here for 30 days. |
| empty | Add Your First File / Decks, PDFs, documents, spreadsheets, photos and videos. Files stay yours: stored in the EU, deleted when you say. / Add Files, Add the Sample Deck |
| account states | Your Account Is Suspended / You can still download your files. Email hi@bloop.here to appeal. / Download All; Your account is deleted on 2 Dec. / Cancel Deletion |

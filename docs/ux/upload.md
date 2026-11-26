# The upload pill

**The rule: every pill and toast state is one line of text: the file name (ellipsized in the middle), a short status word, one action and the close button. No explanatory sentence is on screen; it is the action's accessible name (`aria-label`), the page's polite region, or a visually hidden span inside an alert toast.**

One face for every upload: the library's Add Files (one file or many) and a library drop. A guest's send on `/a` joins it when the guest routes exist (section 6). It is a user of the loader (design.md section 6), shaped as a pill, so there is still one loader in bloop (README.md additions, Upload pill). Client: core/upload.js (U); what the server refuses and why is `docs/threats/uploads.md`.

## 1. The part

```
390, one file, mid upload                        1440 (same part, bottom center of the content column)

            .--------------------------------.
            | +--+ Lecture 5.pptx · 42%   (x) |   56 tall: 8 + a 40 tile + 8; --r-pill; glass
            | |PP|                          |   the loader's fill grows behind the text
            '--------------------------------'
.--------------------------------------------.
| [ Add Files ]          [[ Present ]]       |   the bottom action panel, unchanged under it
'--------------------------------------------'
```

- **Place.** Phone: centered, `--inset` above the bottom action panel (the toast's place; a toast that arrives meanwhile stacks above the pill, never over it). Desktop: bottom center of the content column, `--inset` above the window's foot. Max 360, min 240, as wide as its text.
- **Face.** The tile (40, `--r-pill` concentric: radius 20 for the tile, since 28 - 8) shows the kind glyph; one flex row of text, never wrapped: the name (15/600 `--ink`, middle ellipsis: the head gives way, its last 10 characters stay) then " · status" (`--muted`, tabular, never shrinks). Then at most one action (a text button) and Close (`x`, 44 hit area), named "Cancel Upload of Lecture 5.pptx". Under 360 px wide a pill with an action drops its tile, so the name keeps the room. On a screen under 500 px high the pill and every toast sit at the right edge, clear of the page's centered column.
- **Fill.** The loader's glass fill grows from the left with the bytes confirmed plus the bytes the parts on the wire have sent, `scaleX` over 250 ms `--ease-out`; the sheen sweeps while bytes move. It never moves back (a part that retries holds the fill where it was) and stops at 99 percent until the server has answered, so it never stalls at 100 (UP-11).
- **Role.** `role="progressbar"` named "Uploading Lecture 5.pptx", `aria-valuenow` whole percent; what the line leaves out goes to the page's one polite region ("Checking Your File", "Saved", the file's name while bytes move), never every percent. The region is on the page from the first mount, not made with the pill, so its first words are announced; it is emptied when the pill leaves.
- **Motion.** Enters with the toast's 250 ms rise; leaves 2 s after its final state with the toast's 200 ms exit. Reduced motion: appears and leaves at once, no sheen, fill only.

## 2. States, in order

| State | Line (name · status) | Action | Fill | Close | Polite region |
|---|---|---|---|---|---|
| starting (queued, fingerprinting, create) | Lecture 5.pptx · Starting | none | none, sheen | Cancel | Lecture 5.pptx |
| uploading | Lecture 5.pptx · 42% (whole percent of the file's fraction; no byte counts or time left) | none | bytes | Cancel | Lecture 5.pptx |
| waiting (offline mid upload) | Lecture 5.pptx · Waiting | none | held where it was, no sheen | Cancel | Waiting for a Connection; after 2 minutes: Keep this page open. It finishes when you're back online. |
| checking (complete, then the server validates) | Lecture 5.pptx · Checking | none | full, sheen | none (too late to cancel) | Checking Your File |
| still checking (150 s of checking passed) | Lecture 5.pptx · Still Checking | Check Again (named "Check Lecture 5.pptx again") | full, no sheen, normal tone | none | Still Checking Your File |
| done (the server says ready) | Lecture 5.pptx · Saved | Add to Up Next (named "Add Lecture 5.pptx to Up Next"), in Close's place | full, then leaves | none | Saved |
| paused (tab closed mid upload) | Lecture 5.pptx · Paused | Resume (named "Resume Lecture 5.pptx: choose the file again to finish") | none | Cancel | Lecture 5.pptx Is Paused |

- **Add to Up Next** on the library's Saved pill ticks the file (the same PATCH as the row's tick) and the pill reads "Lecture 5.pptx · Added" for 2 s, then leaves. Holding an action, the Saved pill stays 8 s (the toast-with-action rule, README.md additions), paused while hovered or focused. Absent when Up Next is full, and on a batch's "3 Files · Saved" (one action cannot name three files; the rows' ticks are right there). A row gains its tick only at Saved (library.md section 2), so this is the earliest a file can join a talk.
- **Units.** The pill shows a whole percent only. The batch's sheet keeps byte counts: under 1 MB "340 of 900 KB"; both numbers in the same unit as the total, one decimal under 10 ("3.4 of 8.8 MB"), whole above. Tabular, so the line never jitters.
- **Checking** lasts until the server says the file is ready or refused. The page repeats `POST /complete`, which is idempotent and is where the server checks again (a read of the upload would only repeat what it last said), after 2 s, then 4, 8 and every 10 s (longer when the server's Retry-After says so). A 409 `upload_busy` (another request holds the check) is waited out the same way. "Saved" appears only on the server's answer; only the server's own refusal refuses a file, as a toast (section 4), and a service that keeps answering 5xx after its retries is the `service_busy` refusal ("bloop Is Busy Right Now"). A 5xx that carries a code of its own (`quota_exceeded` is a 507) is that code's refusal, never a failing service.
- **Still checking.** The 150 s clock counts only time spent waiting on a server that could be reached: an outage (Waiting) pauses it, a request that times out counts in full. It is read when complete answers, so the worst case is a complete that keeps timing out (120 s a try, four tries, 1, 3 and 9 s between) after the last read under 150 s: about 11 minutes, plus any outage. Past it the file is neither refused nor saved: the pill reads "Lecture 5.pptx · Still Checking", in the normal tone, keeps the file and offers Check Again, which repeats the same complete for another 150 s. A later ready is "Saved", a later refusal is the refusal, and a dropped connection never ends it. The file stays in the list across the next batch until it settles.
- **Waiting** resumes by itself on `online` or a 15 s probe, from the last confirmed part (the same file resumes: its identity is the name as the server keeps it, the size, and a SHA-256 over the first and last 64 KiB, never `lastModified`, which an iOS picker stamps afresh on each copy; plan A.4). Waiting over 2 minutes changes only what the polite region says ("Keep this page open. It finishes when you're back online."); the pill still reads Waiting.
- **Saved, then what.** The library row appears at the top of All Files as soon as the upload is created (with the loader over its tile, no fill: the pill carries the progress), turns to "Preparing Slides" after checking, then to its thumbnail. For a guest, the screen's receiving pill ends with it (viewers.md).

## 3. Several files

- One pill for the whole batch: "3 Files · 42%", the fill over the batch's total bytes (the pill is named "Uploading 3 Files" and the polite region says it). Files go one at a time in the order chosen (one at a time keeps a weak phone link from splitting three ways, and the first file is ready first).
- Tap the pill (it is a button when it holds several) to open its sheet: the Session Expiry sheet's bubble with one item row per file, each with its own state in line 2 ("Saved", "34 of 88 MB", "Waiting", or a refused file's own reason in `--rose-ink`) and its own Cancel.
- Done: "3 Files · Saved". Some refused: "2 Files · Saved", and the refusals are said once, when the batch ends: one refused file is its own toast (section 4); two or more are one toast, "3 Files · Can't Be Added" (read aloud as "3 Files Couldn't Be Added") with See Why, which opens the batch's sheet with each file's reason on its row.
- A new pick while a batch runs joins the batch.

## 4. Refusals

The phone refuses what it can before a byte is sent, as a toast, and the page stays where it was (design.md section 8, Toast). A toast is one line too: for the codes with a title of their own the line is that title; for every other code it is the file's name · "Can't Be Added". The sentence in the table is the toast's hidden `say` text, inside the alert, so a screen reader reads it; the sheet's row shows it for a batch. The server's refusals after checking are toasts in the library and the full "This File Can't Be Sent" state on `/a` (design.md section 7).

| When | Toast line | Said (hidden) |
|---|---|---|
| type not supported | This File Type Isn't Supported | bloop takes decks, documents, PDFs, spreadsheets, text, photos and videos. |
| empty | This File Is Empty | (none) |
| over the file cap | File Too Large | bloop takes files up to 500 MB. (from the API, never restated; without the number: This file is over bloop's size limit.) |
| over the quota | Not Enough Space | Delete files or empty the trash to add this one. |
| macros, password, damaged (server, after checking) | Lecture 5.pptm · Can't Be Added | This file has macros. Save a copy without them as .pptx. / This file is password protected. Remove the password, then add it again. / This file is damaged. Open it on your computer and save it again. |
| the library is full (too many files) | Your Library Is Full | Delete files you no longer need, then add this one. |
| too many uploads (`rate_limited`) | Too Many Uploads Right Now | Wait a minute, then try again. |
| bloop is busy (`service_busy`) | bloop Is Busy Right Now | Try again in a few minutes. |
| signed out mid upload (`auth_required`) | Sign In to Add Files | Your sign-in ended. Sign in again, then add the file. |
| a guest's pairing ended mid upload (`unauthorized`) | Lecture 5.pptx · Can't Be Added | This phone's pairing ended. Pair it with the screen again, then add the file. |
| the upload ended or changed (`upload_gone`, `upload_aborted`, `size_mismatch`, `not_found`, `bad_request`, `length_required`) | Lecture 5.pptx · Can't Be Added | one line each: This upload ended before it finished. Add the file again. / The upload was stopped. Add the file again. / This file changed while it was being added. Add it again. / bloop can't find this upload. Add the file again. / bloop couldn't take this file as sent. Add it again. / bloop couldn't read this file's size. Choose it again. |
| still finishing (`upload_busy`), or bloop answers something the page cannot use (`service_down`) | Lecture 5.pptx · Can't Be Added | bloop is still finishing this upload. Wait a moment, then try again. / Something's wrong on bloop's side. Try again in a few minutes. |
| the page cannot add files (`forbidden_origin`), or the server cannot read the request (`unsupported_media_type`), or hit a problem of its own (`internal`) | Lecture 5.pptx · Can't Be Added | This page can't add files. Reload it, then try again. / bloop couldn't read this file as sent. Add it again. / bloop hit a problem adding this file. Try again in a few minutes. |
| a guest's caps (the demo's 25 MB, a live guest's limit) | as design.md section 8 | as design.md section 8 |

- A refused library file never becomes a row; its reserved bytes come back (the quota bar drops the `--g2` part).
- A refusal in a batch keeps the batch going.

## 5. Interruptions nobody named

- **Phone locks mid upload.** iOS suspends a background tab's network. The page holds a screen Wake Lock while uploading where the API exists (released at the end, on hide and on cancel), and the waiting state covers the rest. On return the upload resumes from its last confirmed part.
- **Tab closed or reloaded.** The page no longer holds the file's bytes, so it cannot resume by itself. On the next visit to `/library` with an unfinished upload (`GET /api/uploads/:id`), the pill reads "Lecture 5.pptx · Paused" with Resume (named "Resume Lecture 5.pptx: choose the file again to finish"; opens the picker; the same file resumes, matched by the cleaned name and the size and then by the fingerprint the server compares, a different one starts fresh and the paused one is aborted). A new file the server answers with a paused row's upload takes the row's place, so it is listed once.. Dismissing it aborts the upload and frees the reserved bytes.
- **Network change** (Wi-Fi to cellular): a failed part retries 3 times with backoff (1, 3, 9 s) before the waiting state, so a hand-off never shows an error.
- **Presigned URL expired** (a part waiting over 15 minutes): fetched again silently, before it ends but never sooner than half its life.
- **Direct upload blocked** (a campus proxy refusing the storage host): the server picks the mode and the client follows it, never switching on its own; a part that cannot be sent retries 1, 3 and 9 s, then waits for the connection. Direct URLs are used only when they are https, on the storage endpoint's host (`.eu.r2.cloudflarestorage.com`) and carry no credentials; any other is never sent a byte, and the part's URL is asked for again.
- **Cancel.** Close (or Cancel in the sheet) aborts at once, no question: a cancel loses only time, and undo would mean starting over anyway. The close on the server is tried twice, 1 s apart. Toast "Lecture 5.pptx · Canceled", saying "Lecture 5.pptx wasn't added."
- **A storage host's 404** is not bloop's word that the upload is gone: the page asks bloop (the same read as after a connection returns) before it pauses the file, and retries with a fresh URL when the upload is still there.
- **Leaving the page mid upload:** the browser's own "Leave site?" prompt (`beforeunload`), only while bytes are moving, since leaving pauses the upload.

## 6. On `/a` for a guest

Until the guest routes of the upload stream exist, `/a` sends through `PUT /api/drop` as before, and nothing of a guest's goes to the member routes or carries a member's cookie: the engine has no guest kind. When the routes land, the guest gets its own routes, requests that omit credentials, and a test through the real engine that a member's cookie writes nothing; this section then returns with the guest's sending state (design.md section 7, Phone page) and its "Sent" pill.

## 7. Focus, targets, lazy

- The pill never takes focus by itself. Tab reaches it after the page's content and before the action panel. Close is 44 square. When the pill leaves with focus inside it (or its sheet), focus goes back to the control that opened the upload; focus elsewhere is left alone. "Waiting for a Connection" is announced when a wait starts, as a title change is. The pill closes its sheet before it leaves, so the dialog hands focus back to the pill's control while it is still there, and from there it goes to the control that opened the upload. The sheet has its own Close row at the end of its list, besides each file's Cancel.
- The pill's face, its words and its sheet load with the module, on first use of each: the refusals' words only when a file is refused (a plain "Can't Be Added" / "Try again in a moment." stands in when they cannot load), the sheet only when it is first opened.
- The upload module and the pill's CSS load on the first intent to add (library.md section 10; on `/a`, pointerdown on Add a File). If the module fails: toast "Upload Didn't Load" / "Reload the page, then try again." / Reload, and nothing is lost (no bytes were sent).

## 8. Strings (this file)

Starting; {N}%; Waiting; Checking; Still Checking / Check Again; Saved; Added; Paused / Resume; Close; Add to Up Next; {N} Files; Can't Be Added / Try again in a moment. (when the words cannot load); 340 of 900 KB (the sheet); Waiting for a Connection; Keep this page open. It finishes when you're back online.; Checking Your File; Still Checking Your File; Uploading 3 Files and 3 Files Saved (polite region and the batch's names); Uploading {name} (progress name); Cancel Upload of {name}; Check {name} again; Add {name} to Up Next; Resume {name}: choose the file again to finish; {name} Is Paused; {name} · Canceled / {name} wasn't added.; 3 Files · Can't Be Added / See Why; Upload Didn't Load / Reload the page, then try again. / Reload; the refusal toasts in section 4 (each upload error code has a string of its own, tested).

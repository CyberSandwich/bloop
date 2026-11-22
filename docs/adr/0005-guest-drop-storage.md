# ADR 0005: guest-drop storage and deletion

Status: proposed

## Context
A guest sends one `.pptx` or `.pdf` from their phone into one session, with no account and no tenant consent, often with the host absent. It is the one stored copy of third-party content. ADR 0001 picks R2 (`eu`) with a 1-day lifecycle backstop, and no malware scanner.

## Decision
- **Who may drop:** a policy per room, `off`, `open` or `pass`.
  - `open` (default, host-absent): no host and no pass. A guest scans the screen's code and uploads. The screen then shows the file name with an "Open" button, and the file opens only after a click on the screen itself. That click proves physical presence at the lectern, and launching `ms-powerpoint:` likely needs a user gesture anyway (T3). An unclicked offer expires after `CLAIM_TIMEOUT_SECONDS`, and the object is deleted. The 60 s code and the first-phone lock apply as for any pairing.
  - `pass` is optional per room, turned on by IT (OD-2): the host signs in and creates a guest link `https://<host>/g#p=<pass>`, which lasts 24 h and covers one session. The pass sits in the fragment, so it reaches no server log, and only its hash is stored. The Open click still applies.
- **Upload:** `PUT /api/drop` with Bearer pid, `Content-Length` required, at most `GUEST_MAX_BYTES` (default 50 MB; the platform cap is 100 MB). The body streams to R2 at `g/<random 128-bit>` through a byte counter that aborts at the cap.
- **Validation after the store, by range reads only, with no decompression:**
  - head bytes;
  - for decks, the zip end record and central directory: limits in `ZIP_LIMITS`, required parts, refused macro, ActiveX and `.bin` parts, no Zip64;
  - for PDFs, the tail: `%%EOF`, and no ZIP end record (polyglot);
  - the extension and the detected type must agree.
  - Any failure deletes the object before the response.
- **Serving:** only through the session's `/f/` link, with the detected Content-Type, `nosniff`, and `attachment` (pptx) or `inline` (pdf).
- **Deletion, three layers:**
  1. the session's end (phone, screen, 90 min, cancel or timeout) deletes the object, and sets `guest_file.deleted_at`;
  2. an hourly cron deletes any object older than 2 h, and any row with no `deleted_at` whose session has ended;
  3. the bucket lifecycle rule deletes anything older than 1 day.
- **Budget:** live guest bytes are summed in D1. Above `GUEST_STORAGE_BUDGET_BYTES`, uploads get `storage_full`.
- **Fallback if R2 is unavailable or needs a card the owner declines:** the same `GuestDrop` interface stores 4 MB chunks in the Screen object, and `deleteAll()` at end deletes them. That caps guest files lower, and it is the only change.

## Consequences
- The server never parses deck content beyond the zip directory, so its attack surface stays small. PowerPoint's Protected View and Mark of the Web stay the PC's defense.
- Some legitimate decks with OLE embeds will be refused. The refusal rate is measured and the rule revisited.
- "bloop deletes its copy when this ends" is true for bloop's storage. The PC's downloaded copy is a T20 question.

## Revisit when
- A buyer requires scanning. Add it behind `GuestDrop.accept`.
- The refusal rate passes 2% of drops.

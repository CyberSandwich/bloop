# ADR 0005: guest-drop storage and deletion

Status: accepted (built; the `eu` bucket, the lifecycle rule and the card question are unverified until the real account exists, F-CF)

## Context
A guest sends one `.pptx` or `.pdf` from their phone into one session, with no account and no tenant consent, often with the host absent. It is the one stored copy of third-party content. ADR 0001 picks R2 (`eu`) with a 1-day lifecycle backstop, and no malware scanner.

## Decision
- **Who may drop:** a policy per room, `off`, `open` or `pass`. Until rooms exist (module g) the policy is the `GUEST_DROP` variable; a demo screen always takes drops.
  - `open` (default, host-absent): no host and no pass. A guest scans the screen's code and uploads. The screen then shows the file name with an "Open" button, and the file opens only after a click on the screen itself. That click proves physical presence at the lectern, and launching `ms-powerpoint:` likely needs a user gesture anyway (T3). An unclicked offer expires after `CLAIM_TIMEOUT_SECONDS`, and the object is deleted. The 60 s code and the first-phone lock apply as for any pairing.
  - `pass` is optional per room, turned on by IT (OD-2): the host signs in and creates a guest link `https://<host>/g#p=<pass>`, which lasts 24 h and covers one session. The pass sits in the fragment, so it reaches no server log, and only its hash is stored. The Open click still applies. Guest passes are module g's; until then a `pass` room refuses every drop (`pass_required`, `pass_invalid`).
- **Choosing to send:** the QR does not say who is scanning, so a phone claims as an owner by default and can choose "Send a File Instead". The first `PUT /api/drop` turns that claim into a guest in the machine (`upload.start` from `claimed` or `choosing`), dropping its list and account. A claim made with `kind: "guest"` starts as a guest.
- **Upload:** `PUT /api/drop`, Bearer pid, `Origin` equal to `PUBLIC_ORIGIN`, `Content-Type` one of octet-stream, PDF or PPTX (a phone may declare nothing useful), `Content-Length` required, at most the screen's cap (`GUEST_MAX_BYTES`, default 50 MB, at most the platform's 100 MB; demo `DEMO_GUEST_MAX_BYTES`, 10 MB). `X-Bloop-Name` carries the percent-encoded name; its extension is the declared type. Order: Origin, credential shape, platform rate limit, length and name, then the Screen object (policy, one file per session, cap, state `uploading`), then the budget reservation, then the store. The body streams to R2 at `g/<random 128-bit>` through a `FixedLengthStream` of the declared length (a longer or shorter body errors, so the declared length is the byte counter) and a SHA-256 digest stream.
- **Validation after the store, by range reads only:**
  - head bytes decide the detected type (`PK\x03\x04` deck, `%PDF-` PDF); it must equal the extension's type, else `bad_type`;
  - decks: no `%PDF` in the first 1 KB; the zip end record must be plausible (its comment length reaches the end of the file); no Zip64, multi-disk or encrypted entries; at most 5,000 entries, a 2 MiB central directory, 1 GiB declared in total, 200:1 per entry from 64 KiB up (smaller parts legitimately compress further); required parts `[Content_Types].xml` and `ppt/presentation.xml`; refused `vbaProject.bin`, `ActiveX/` and any `.bin` part, and macro content types. The one inflate is `[Content_Types].xml`, capped at 256 KiB, to read the content types; nothing else is decompressed;
  - PDFs: `%%EOF` in the last KB, and no plausible zip end record in the last 64 KiB (polyglot);
  - any failure deletes the object before the response, and the session returns to `claimed` so the guest can choose another file.
- **Serving:** only through the session's `/f/` link (the `FileRef.ref` is the object key), with the type from detection, `nosniff`, and `attachment` (pptx) or `inline` (pdf view). The key is the capability, there is no list or read route, and a token belongs to one screen.
- **Deletion, three layers:**
  1. the session's end (phone End, screen End, auto-end, cancel, Start Over, an expired offer or upload) purges the object and sets `guest_file.deleted_at`, by key when the session holds the file and by session id when an upload had no ref yet; each delete that found something is audited as `guest.deleted`; a failing delete is logged and never stops the session from ending;
  2. an hourly cron lists `g/` and deletes any object older than 2 h, and closes any `guest_file` row that old;
  3. the bucket lifecycle rule deletes anything under `g/` older than 1 day. It is not expressible in `wrangler.jsonc`, so it lives in `tools/r2-lifecycle.json` and `deploy.yml` applies it with `wrangler r2 bucket lifecycle set`.
- **Budget:** `guest_file.bytes` of live rows is summed in D1 by the same statement that reserves the row (so two drops cannot both pass). Above `GUEST_STORAGE_BUDGET_BYTES` a drop gets `storage_full`. The row is reserved with the declared length before any byte is stored, and updated with the stored size and digest after.
- **Free-tier hard stop:** R2 is the one product on the account that can bill and it has no spending cap, so bloop counts its own R2 operations in D1 (`r2_ops`, one row per UTC month and class, incremented atomically before the call; `seams/guest-drop/meter.ts`). Class A (put, list) is capped by `R2_CLASS_A_MONTHLY_CAP` (default 500,000) and class B (get, head) by `R2_CLASS_B_MONTHLY_CAP` (default 5,000,000), 50% of the free tier's 1M and 10M, because the billing period may not align with calendar months and any 30 days span two; a single delete (DeleteObject) is free and never counted or refused, the sweep's bulk delete is not documented as free and counts as one class A. At a cap a drop gets `storage_full`, and a `/f/` read of a guest file gets `upstream_failed`. A counter that cannot be written refuses the operation. The stored-bytes budget above covers the 10 GB.
- **Fallback if R2 is unavailable or needs a card the owner declines:** `GuestDrop` is the only seam, and `seams/guest-drop/select.ts` the only place that names R2. A chunk store in the Screen object would implement the same interface. It is not built: R2 runs locally, so nothing forced it. Its size cap is lower than first written here, because a SQLite-backed Durable Object value is at most 2 MB, so chunks are at most 1.5 MB and the cap would be about 20 MB.

## Consequences
- The server never parses deck content beyond the zip directory and one small part, so its attack surface stays small. PowerPoint's Protected View and Mark of the Web stay the PC's defense.
- Some legitimate decks with OLE embeds will be refused. The refusal rate is measured and the rule revisited.
- "bloop deletes its copy when this ends" is true for bloop's storage, and V-5 is now verified. The PC's downloaded copy is a T20 question.
- Declared zip sizes can lie, so a deck may still stall PowerPoint on the PC (DROP-04): the damage stays on one screen for one session.
- A closed connection mid-upload leaves the session `uploading` until `UPLOAD_TIMEOUT_SECONDS` or the phone's Cancel; the reserved row and any partial object go with the purge.

## Revisit when
- A buyer requires scanning. Add it behind `GuestDrop.accept`.
- The refusal rate passes 2% of drops.
- R2 needs a card the owner declines: build the chunk store.

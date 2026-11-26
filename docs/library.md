# The library

How a signed-in user's files are stored, listed, changed and served. The decisions are ADR 0016; the data model is ADR 0013; the page is [ux/library.md](ux/library.md). Threat rows: [threats/library.md](threats/library.md).

## 1. Parts

| part | file | holds |
|---|---|---|
| store | `src/worker/library/store.ts` | every `library_file` read and write, the serving predicate |
| names | `src/worker/library/names.ts` | the rename rule |
| preview tokens | `src/worker/library/preview.ts` | mint and verify `/p/` tokens |
| purge | `src/worker/library/purge.ts` | due files, in two passes |
| account purge | `src/worker/library/account-purge.ts` | a user's erasure, the tombstone resweep, the orphan scan |
| hold | `src/worker/library/hold.ts` | the NCA copy of a reported file |
| retention | `src/worker/library/retention.ts` | the cron's clocks, the inactivity warning, `resumeClocks` |
| export | `src/worker/library/export.ts`, `zip.ts`, `src/worker/routes/library-export.ts` | the snapshot, the archive layout, the download |
| answers | `src/worker/library/wire.ts` | a row and the list answer as the page reads them |
| member | `src/worker/library/member.ts` | the session's member (label C) |
| routes | `src/worker/routes/library.ts` | `/api/library*` |
| user object | `src/worker/do/user-library.ts` | progress, the page socket, live screens, the export lease, the purge alarm |
| its rows | `src/worker/do/user-library-rules.ts`, `src/worker/do/user-library-schema.ts` | the row logic and the storage shape |

## 2. The store

- Every statement binds the owner (`user_id = ?1`); a foreign id and an unknown id are the same `not_found`.
- **Serving.** `SERVABLE_SQL` is the one predicate: owner, `ready`, untrashed, enabled, an active unsuspended owner. A fetch for a screen adds `PINNED_SQL`, the pairing's phone session still being live, so a sign-out stops new fetches within the 5-second cache even when the screen-ending call failed. `servable` answers many refs in one query per 90 and refuses a ref whose version differs from the row's.
- **List.** A page is 200 rows. `updated` is newest first, `name` sorts naturally (Lecture 2 before Lecture 10), `size` largest first, the trash by due time. The cursor holds the last row's sort values, so it survives that row's deletion. Rows come from one read of the owner's rows, which `LIBRARY_MAX_FILES` bounds, so every sort is in memory.
- **Names.** NFC, trimmed, 1 to 200 characters with the extension. Control characters, line and paragraph separators, bidi overrides and isolates, and both slashes are refused. The extension is the file's and never changes; a rename leaves `updated_at` alone because it marks content.
- **Up Next** is `selected_at` on at most 12 untrashed rows, in tick order. A tick is one guarded `UPDATE` that counts the ticked rows in the same statement, so 20 concurrent ticks leave 12. `setUpNext` clears the untrashed rows it does not name and stamps the named ones in one batch, which serves reorder, Clear and its Undo.
- **Trash.** `trashed_at` and `purge_after` (now plus `TRASH_DAYS`); the tick stays. Restore needs `purge_after` more than 5 minutes ahead, and drops the tick when it would be the 13th. Delete Now and Empty Trash move `purge_after` into the past (`makeDue`), which closes restore at once.
- **Presented.** `markPresented` returns the statements (one per 90 ids, under D1's bind limit) that P1's approve batch runs.

## 3. Preview tokens

`p1.<kid>.<claims>.<mac>`: the claims are the file id, its version, the asset kind (`bundle` or `original`) and an expiry at most 300 s ahead; the MAC is HMAC-SHA-256 over everything before it with `FILE_TOKEN_KEY`. `kid` names the signing key by a short hash, so a verifier given the current and the previous key picks the right one. Verification checks the shape, then the MAC in constant time, then the clock. A token proves bloop minted it lately for this file version; the `/p/` handler still runs the serving predicate at every fetch.

## 4. The user object

One per user, `idFromName(userId)` in the EU jurisdiction, reached only with a user id taken from the session or from server state. It holds four tables, all ephemeral, and never a library row:

| table | holds | bound |
|---|---|---|
| `progress` | per file and version: stage, done, total | deleted on ready or failed, else after a day |
| `screen` | a live screen the user approved: its session, the phone session, a label, the file ids | at most 20 rows, the oldest ended one goes first |
| `lease` | the export lease | 15 minutes, renewed while read |
| `idem` | the first answer stored for an Idempotency-Key | 24 hours |

- **Schema.** Version 1 is never edited. On every wake each table's columns are compared with the shipped shape; a table of another shape is dropped and recreated, and `user_library_schema_repaired` is logged once.
- **Socket.** A page opens one hibernating WebSocket, tagged with its phone session's public id; at most 6 are open and the oldest is closed with 4000. The runtime answers pings itself. The object sends `hello` with the current progress, then `progress` frames (at most one a second per file, plus every stage change), `first` when page 1 is stored, `ready` or `failed`, and `quota` when a purge freed bytes. A client's frames are ignored.
- **Alarm.** One alarm at the next need: a socket's 12-hour age limit, an hourly sweep while any ephemeral row is left, or the next purge round. The object sets no timer and holds no un-awaited promise, so it hibernates between frames.
- **Export lease.** `exportBegin` takes a 15-minute lease or answers false; `exportBeat` renews it while the download is read (at most once a minute); `exportEnd` frees it; `exportActive` is what the purge asks. The runtime does not always report a client that vanished mid-download, so the lease must lapse by itself: a download nobody reads stops beating and frees the next export within 15 minutes.

## 5. Purge

`purgeDueFiles` takes up to 50 rows with `purge_after <= now`, skipping suspended and purging owners and any owner whose export lease is live. Per file, by pass:
- **Pass 1** (status not yet `purged`): stop the conversion, empty the prefix `u/<uid>/<fid>/` by listing it in rounds of 1,000, then one batch releases the owner's bytes (guarded by the row still being due and its status being `checking` or `ready`, so a refused file, whose bytes went at refusal, frees nothing) and marks the row `purged` with a later due time (31 minutes).
- **Pass 2** (status `purged`, due again): empty the prefix once more, which catches a put that was already awaiting during pass 1, then delete the `derived` rows and the row.
- A run has a budget of listing rounds; when it runs out the file stays due and the next run continues. A crash at any delete leaves the row over a part-emptied prefix, which the next run finishes; bytes are released once, whoever runs.

Delete Now and Empty Trash make rows due and call `kickPurge`, whose alarm runs the user's rounds 30 seconds apart while more are due and pushes `quota` to open pages when bytes were freed.

## 6. Routes

All under `/api/library` (and the two screen routes under `/api/me`), all for a member session (label C, ADR 0014) that the launch lockout admits; a request without one, from a suspended member or from a locked-out one gets the signed-out answer, and a member in the deletion grace gets `account_deleting` with the date. Each spends `RL_LIBRARY` keyed by the user and answers `no-store`.

| method, path | body | answer |
|---|---|---|
| GET `/api/library?view&sort&cursor` | | the list: `files`, `next`, open `uploads`, `upNext`, `quota`, `trash`, `limits`, `switches`, `account`; a strong `ETag`, 304 on `If-None-Match` |
| PATCH `/:id` | `{name}` or `{selected}`, never both | the row |
| PUT `/up-next` | `{ids}`, at most 12 | `{upNext}`, the order that resulted |
| POST `/:id/trash` | `{}` | `{file, leftScreens}`: the labels of live screens showing it |
| POST `/:id/restore` | `{}` | the row; `not_found` once it is due or within 5 minutes of it |
| POST `/trash/delete` | `{ids}` (at most 150) or `{all: true}` | 202 `{due}` |
| POST `/:id/preview` | `{asset}` | `{base, exp}`; `file_disabled` for a disabled file; `service_busy` while previews are off |
| GET `/ws` | an Upgrade from our own Origin | 101; the socket of section 4 |
| GET `/api/me/screens` | | `{screens: [{sessionId, label, fileIds, startedAt}]}`: the live ones |
| DELETE `/api/me/screens/:sessionId` | `{}` | `{ended}`: the screen is told to end through its own object, which ends it only when the pairing's user is this one; 0 when it was already gone |

A thumbnail link in a row is a bundle token whose expiry lands on a 150 s boundary, so the list answer, and its ETag, holds still between refreshes. A row names only what is true of it: null fields are left out.

## 7. Retention, account purge and holds

`runLibraryRetention` runs from the cron (`cron-jobs.ts`): hourly it does the due work, daily it adds the scans. Each job has its own allotment of listing rounds and rows, so one backlog never starves another, and a job that finds more says so.

- **Due trash** is section 5.
- **Account purge** (`purgeUser`, ADR 0013 steps 0 to 5). The claim is one guarded `UPDATE` to `purging`: the user is due (`delete_after` passed), active or deleting, not suspended and under no live hold. From then no sign-in, restore or reservation succeeds. Then the live screens end, the sessions go and their sockets close, open uploads are aborted (an upload claimed within 120 s settles on its own, so the run stops and the next continues), conversions stop, the prefix `u/<uid>/` is emptied by listing, the `derived` rows and the user object go, the tombstone `purged/<uid>` is written, and last the invite, waitlist and user rows go in one batch. A crash leaves a `purging` row that the next run finishes; rows go last.
- **Resweep.** A tombstone past its `resweepAfter` (31 minutes) has its prefix emptied once more, which catches a put that was already awaiting at purge time; the tombstone is then deleted. A run reads 100 tombstones from a stored list cursor (the tombstone reads count against the run's budget), so a long list is reached over several runs.
- **Orphans.** Daily, the prefixes under `u/` are listed with a delimiter, 1,000 a run from a stored cursor, and one whose owner row is gone is emptied.
- **A pending hold stops the bytes.** A file whose hold copy is not yet made is skipped by the trash purge, and an account purge waits at step 4 while a hold on the user lacks its copy. Accounts under a live hold are left out of the due list, and owners with a live export or a pending hold are left out of the trash purge's window, so none of them can fill it.
- **Inactivity.** Daily, members unused for `INACTIVE_DAYS` get the warning email; only after it was sent does one guarded update set `inactive_warned_at` and `delete_after`, so a sign-in in between wins and a failed send changes nothing. While the preview lockout is set only the members who could have signed in are considered, chosen in the query. A member's use clears the mark.
- **Suspension** pauses every clock: `resumeClocks` shifts `purge_after`, `delete_after` and `last_seen_at` later by the time spent suspended, in the unsuspend batch ahead of the statement that clears `suspended_at`. The pause is read from the row and applied only while the row is still suspended, so a retried or concurrent unsuspend shifts once.
- **Holds.** `holdFiles` copies a reported file, library or guest, to `h/<holdId>` in the library bucket, never the guest bucket (its one-day expiry is bucket-wide). The `hold` row is written first, so a copy is never untracked, and a retry finishes a missing copy; at most 10 are copied per call. Neither purge lists or deletes `h/` or `purged/`. `releaseHolds` deletes the copy, then the row, once `release_after` (a year) has passed.

## 8. Export

`GET /api/me/export.zip?k=<key>`, a navigation, so the idempotency key is a query parameter. It needs a member session, `Sec-Fetch-Site: same-origin` (checked before any storage is read) and, for a new export, a session that proved itself within the re-authentication window (C+R). The `export` switch must be on.

- **Archive.** STORE only, names UTF-8 (bit 11), no data descriptors: every CRC and size is known before the first byte, the file CRCs coming from `library_file.crc32`, so no stored byte is hashed. Order: the README, `Files/` by id, `Trash/` by id, then the data file. Names are NFC, with controls, bidi characters, separators and Windows' forbidden characters replaced, device names prefixed, at most 200 bytes with the extension kept, and de-duplicated without regard to case (`Lecture (2).pptx`). A disabled file, or one that has not settled, is listed in the data file with `path: null` and its bytes are left out. Entry times are each file's `updated_at` and, for the README and the data file, the newest change in the snapshot, in UTC. An export's own audit row is left out of the trail, so the same library always gives the same bytes. Zip64 covers offsets and the end record only; an entry's size always fits 32 bits.
- **Snapshot.** Account, sessions (label, method, times; never an id), passkeys (name, times, backed up; never a key), every library row of the user, and the audit rows `/api/me/audit` shows, at most 10,000.
- **ETag** is an HMAC with `FILE_TOKEN_KEY` over the user and every entry's name, size and CRC, so it changes with anything the archive holds and cannot be computed by anyone else. `Content-Length` is exact (`FixedLengthStream`), so a cut download fails visibly and never reads as a short zip.
- **Order of checks.** Same-origin, key shape, member, `RL_LIBRARY`, switch; then the proof (unless resuming), the lease (`export_busy`, also for a retry of the same key while it is live) and the daily start (`export_limit`); then the snapshot, the audit row `library.export` (a failure refuses the export), and the first byte.
- **Resume.** `Range: bytes=a-` or `a-b` with an `If-Range` equal to an ETag issued in the last day needs only the session, and no new daily start. The snapshot is rebuilt: if its ETag still matches, the answer is 206 with `Content-Range`, the pump starting at the segment holding `a` with a ranged read for a partial file. If anything changed, or the range is not a single one, the answer is a whole new download under the full rules (proof and daily start). A range past the end is 416.
- **Pump.** Each file's key is checked to be under `u/<uid>/` before it is read; a missing object or a size that differs from the row is a stream error, never a skipped entry. The lease is freed on the end, a cancel or an error, and renewed every minute while the client reads.
- **Races.** Purges skip a user with a live lease, so every object in the snapshot exists until the stream ends. The account purge does not wait: its deletes fail the next read, so the download fails visibly. A rename during the download changes nothing: the snapshot's names win.

# The library

How a signed-in user's files are stored, listed, changed and served. The decisions are ADR 0016; the data model is ADR 0013; the page is [ux/library.md](ux/library.md). Threat rows: [threats/library.md](threats/library.md).

## 1. Parts

| part | file | holds |
|---|---|---|
| store | `src/worker/library/store.ts` | every `library_file` read and write, the serving predicate |
| names | `src/worker/library/names.ts` | the rename rule |
| preview tokens | `src/worker/library/preview.ts` | mint and verify `/p/` tokens |
| purge | `src/worker/library/purge.ts` | due files, in two passes |
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
- **Presented.** `markPresented` returns the statement P1's approve batch runs.

## 3. Preview tokens

`p1.<kid>.<claims>.<mac>`: the claims are the file id, its version, the asset kind (`bundle` or `original`) and an expiry at most 300 s ahead; the MAC is HMAC-SHA-256 over everything before it with `FILE_TOKEN_KEY`. `kid` names the signing key by a short hash, so a verifier given the current and the previous key picks the right one. Verification checks the shape, then the MAC in constant time, then the clock. A token proves bloop minted it lately for this file version; the `/p/` handler still runs the serving predicate at every fetch.

## 4. The user object

One per user, `idFromName(userId)` in the EU jurisdiction, reached only with a user id taken from the session or from server state. It holds four tables, all ephemeral, and never a library row:

| table | holds | bound |
|---|---|---|
| `progress` | per file and version: stage, done, total | deleted on ready or failed, else after a day |
| `screen` | a live screen the user approved: its session, the phone session, a label, the file ids | at most 20 rows, the oldest ended one goes first |
| `lease` | the export lease | 2 hours |
| `idem` | the first answer stored for an Idempotency-Key | 24 hours |

- **Schema.** Version 1 is never edited. On every wake each table's columns are compared with the shipped shape; a table of another shape is dropped and recreated, and `user_library_schema_repaired` is logged once.
- **Socket.** A page opens one hibernating WebSocket, tagged with its phone session's public id; at most 6 are open and the oldest is closed with 4000. The runtime answers pings itself. The object sends `hello` with the current progress, then `progress` frames (at most one a second per file, plus every stage change), `first` when page 1 is stored, `ready` or `failed`, and `quota` when a purge freed bytes. A client's frames are ignored.
- **Alarm.** One alarm at the next need: a socket's 12-hour age limit, an hourly sweep while any ephemeral row is left, or the next purge round. The object sets no timer and holds no un-awaited promise, so it hibernates between frames.
- **Export lease.** `exportBegin` takes a 2-hour lease or answers false; `exportEnd` frees it; `exportActive` is what the purge asks.

## 5. Purge

`purgeDueFiles` takes up to 50 rows with `purge_after <= now`, skipping suspended and purging owners and any owner whose export lease is live. Per file, by pass:
- **Pass 1** (status not yet `purged`): stop the conversion, empty the prefix `u/<uid>/<fid>/` by listing it in rounds of 1,000, then one batch releases the owner's bytes (guarded by the row still being due and its status being `checking` or `ready`, so a refused file, whose bytes went at refusal, frees nothing) and marks the row `purged` with a later due time (31 minutes).
- **Pass 2** (status `purged`, due again): empty the prefix once more, which catches a put that was already awaiting during pass 1, then delete the `derived` rows and the row.
- A run has a budget of listing rounds; when it runs out the file stays due and the next run continues. A crash at any delete leaves the row over a part-emptied prefix, which the next run finishes; bytes are released once, whoever runs.

Delete Now and Empty Trash make rows due and call `kickPurge`, whose alarm runs the user's rounds 30 seconds apart while more are due and pushes `quota` to open pages when bytes were freed.

## 6. Routes

All under `/api/library`, all for a member session (label C, ADR 0014) that the launch lockout admits; a request without one, from a suspended member or from a locked-out one gets the signed-out answer, and a member in the deletion grace gets `account_deleting` with the date. Each spends `RL_LIBRARY` keyed by the user and answers `no-store`.

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

A thumbnail link in a row is a bundle token whose expiry lands on a 150 s boundary, so the list answer, and its ETag, holds still between refreshes. A row names only what is true of it: null fields are left out.

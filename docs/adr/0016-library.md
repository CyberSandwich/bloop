# ADR 0016: the library

Status: proposed. Data model: ADR 0013. Serving and pairing: ADR 0015. Behavior and wire shapes: [library.md](../library.md). Rows: [threats/library.md](../threats/library.md).

## Context
- The library is a signed-in user's own files in EU R2, with D1 rows (ADR 0013) and one Durable Object per user for what is ephemeral: conversion progress, the page's socket, live screens and the export lease.
- A presenter fetches a file from the file origin minutes or hours after approving it, so every fetch must re-judge the file (ADR 0015). The same rule serves the list, approve, previews and the converter's publish step.
- Trash, export and erasure each touch R2 in bulk, so each must be bounded, repeatable and safe to run twice.

## Decision

### One serving predicate
- `SERVABLE_SQL` in `src/worker/library/store.ts` is the only statement text for "may this file be served now": owner, `ready`, untrashed, enabled, an active unsuspended owner, the ref's version, and, for a screen's fetch, the pairing's session still live. V2's publish step imports the same fragment. A grep test fails on a second copy (LIB-14).
- Every library read and write names `user_id` (LIB-01). A class guard test greps each `library_file` statement in `library/`.

### Writes are guarded updates, never inserts
- Rename, trash, restore, tick and the batch that sets Up Next are single `UPDATE`s guarded by owner and state. A request that finds nothing to change answers `not_found`, so no interleaving of rename, trash, restore and purge can resurrect a row (LIB-12).
- Every write is an absolute state, never a toggle: a doubled request lands the same result.
- Up Next is `selected_at`, at most 12 untrashed rows, ordered by tick time. Trash keeps the tick; restore drops it only when it would be the 13th.
- Replacing a file's original is out of v4: replace means delete, then upload. So `version` stays 1 and nothing leaves a `v<n-1>/` behind.

### Trash and purge
- Trash sets `trashed_at` and `purge_after`. The purge takes `purge_after <= now`; a restore needs `purge_after > now + 5 minutes`. The two sets never meet, so there is no claim column and clock skew under 5 minutes cannot resurrect a row whose bytes are gone. Delete Now and Empty Trash set `purge_after` to the past, which closes restore at once.
- A purge pass deletes the file's R2 prefix `u/<uid>/<fid>/` in rounds of 1,000 (so unrecorded keys go too), releases the user's bytes once with a guarded batch, marks the row `purged`, and deletes the prefix a second time after the converter's lease window, because a put that was already awaiting can land after the first pass (arch 9b). Bytes go before rows.
- The Durable Object alarm runs the user's due purges (`kickPurge`) and re-arms while more are due; the daily cron runs them for everyone. Both are idempotent.

### Account purge and the hold
- ADR 0013's steps 0 to 5, resumed by the daily job, plus a second prefix delete once a tombstone passes its resweep time. A live NCA hold, or a suspension, blocks the claim.
- A hold copies the original to the library bucket's `h/<holdId>`, never the guest bucket (its 1-day expiry is bucket-wide), after writing its `hold` row. Holds sit outside `u/` and `purged/`, so no purge touches them.

### Export
- A STORE-only zip with each entry's real CRC and size in its local header (U computes the CRC at upload, so no file byte is hashed), no data descriptors, Zip64 only for offsets and the end records. The whole archive is a pure function of the snapshot, so `Content-Length`, `ETag` and `Range` resume are exact (O18). A disabled file is listed but its bytes are left out.
- One export at a time per user (a 2-hour lease in the user's object), capped per day by the spend guard. A purge skips a user with a live lease; an account purge does not wait.
- New abstractions, each removable: the zip layout (`library/zip.ts`) and the alarm-driven purge. No new dependency.

### Preview tokens
- `p1.<kid>.<claims>.<mac>`, an HMAC with `FILE_TOKEN_KEY` over a file id, a version and an asset kind, at most 300 s. The key id lets a rotation accept the previous key until its tokens expire. A preview URL is a 5-minute bearer for one file (it must load in an `<img>`); the `/p/` handler re-judges the file at every fetch.

## Rejected
- **A claim column for the purge:** the time margin does the same job with no extra write.
- **A toggle `PATCH`:** a retry or a second tab would flip the state back.
- **Virtualized lists:** `content-visibility: auto` on rows is enough at the row bound.
- **A hold copy in the guest bucket:** the bucket-wide lifecycle would delete it.

## Consequences
- The page's list answer carries the limits, so no number is restated in the client.
- A trashed file keeps counting against the quota until it is purged, which is what R2 holds.
- The only per-user timers are Durable Object alarms, so the object hibernates between frames (LIB-11).

## Threats served
LIB-01 to LIB-14, OSA-02.

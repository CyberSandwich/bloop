# ADR 0013: accounts and library data model

Status: proposed. Ships with `migrations/0005_accounts_library.sql`. It follows ADR 0012 (additive migrations, no enum CHECK) and is amended by ADRs 0014, 0015, 0016 and 0026 only where they name a column.

## Context
- bloop v4 adds invite-only email accounts, a per-user file library in EU R2, direct multipart uploads, converted outputs, moderation, and a launch switch. Every one of them needs D1 rows.
- D1 today has one identity shape: `app_user` keyed by Entra `(tid, oid)`, with `phone_session` and `token_grant` hanging off it by `ON DELETE CASCADE` (`migrations/0001_init.sql`).
- D1 enforces foreign keys. SQLite looks up an FK child row by scanning unless the child column has a usable index, and a partial index does not count.
- The daily job deletes any `app_user` row with no grant, no session and `last_seen_at` older than 30 days (`src/worker/retention.ts`). Written for Entra users who hold nothing, it would delete an email user, and by cascade their library rows, 30 days after their last session ends.
- The existing erase route (`DELETE /api/me` in `src/worker/routes/auth.ts`, through `Sessions.deleteUser`) deletes the user row at once, which for an email user would cascade the D1 rows and orphan every R2 object.
- D1 Time Travel keeps 30 days of restorable history, so a deleted row is recoverable by the operator for 30 days.
- 0004 (indexes) lands before 0005., and data-hardening's identity and org migration is 0006 or later.

## Decision

### Identity
- **Email identities share `app_user`.** An email user is a row with `tid = 'email'` and `oid = id`. An Entra tid is a GUID, so `UNIQUE (tid, oid)` cannot collide. `email_norm` has a partial unique index and is NULL for Entra rows. An Entra user and an email user with the same address are two accounts, so no Entra user is ever keyed by email (AUTH-04 holds). Why: every existing FK, the session code and the audit join keep working unchanged.
- **One normalizer.** Trim, lowercase, at most 254 characters, ASCII only: an address with any non-ASCII character is refused (`email_invalid`), so no Unicode confusable can make a second account for a same-looking address. No dot or plus folding. `email_norm`, `ADMIN_EMAILS`, `TEST_EMAILS`, invites, codes and the waitlist all go through this one function; the config parse runs the secrets through it too.
- **Terms:** `terms_version` and `terms_accepted_at` are written when an invite is accepted (the acceptance page says "By continuing you confirm you are 18 or over and accept the Terms"). A later Terms change can ask for acceptance again by comparing the version.

### Account life: status and suspension are separate
- **`status` is `active`, `deleting` or `purging`** (zod only). **Suspension is `suspended_at IS NOT NULL`**, with `suspended_reason`, independent of status, so suspending a user in the deletion grace keeps the deletion, and unsuspending leaves it as it was.
- **"Active" means `status = 'active' AND suspended_at IS NULL`** everywhere it is a guard: the C auth label (plan A.4), the quota reserve, code mail, session creation, the library FileSource, the fetch-time check.
- **`delete_after`** is the one clock for both inactivity deletion (`status = 'active'`) and requested deletion (`status = 'deleting'`). A `deleting` user who signs in may reach only `GET /api/me` and `POST /api/me/restore`. A `purging` user gets no code, no session and no reserve.
- **Restore** is `UPDATE ... SET status = 'active', delete_after = NULL WHERE id = ? AND status = 'deleting' AND delete_after > :now`; zero changes is `restore_too_late`.
- **Activity clock is the existing `last_seen_at`.** It is set at sign-in and touched at most once a day when a session resolves. There is no second `last_active_at`: two clocks for one fact. Any sign-in or use clears `inactive_warned_at` and the inactivity `delete_after` by `UPDATE ... WHERE id = ? AND status = 'active'`, so it can never undo a requested deletion or a purge.
- **Inactivity sweep** (`idx_app_user_idle`): warns at `INACTIVE_DAYS` and sets `delete_after` `INACTIVE_GRACE_DAYS` later. While `preview_lockout` is set (ADR 0026) it skips members the lockout refuses (outside `ADMIN_EMAILS` plus `TEST_EMAILS`), since they could not have signed in.
- **The user-row sweep never touches email users.** The retention query gains `AND tid != 'email'` in the same deploy that applies 0005. Email users leave only through the purge below. A test proves an email user with no session survives the sweep (LIB-09).
- **The erase route hands email users to the purge.** `DELETE /api/me` keeps its immediate erase for Entra rows; for `tid = 'email'` it is the C+R deletion request (ADR 0014: status `deleting`, `delete_after` now plus `ACCOUNT_DELETE_GRACE_DAYS`). `Sessions.deleteUser` is never called on an email row outside purge step 5; a test asserts it.

### Account purge
Runs from the cron for each user whose `delete_after` has passed. Idempotent and resumable: a crash at any step leaves a `purging` row that the next run continues.
0. **Claim:** `UPDATE app_user SET status = 'purging' WHERE id = ? AND delete_after <= :now AND status IN ('active', 'deleting')`. Continue only on one change; a later run continues a row already `purging`. From here no sign-in, restore or reserve can succeed.
1. End live screens (`UserLibrary.endScreens`), then delete every session.
2. Abort open multipart uploads (R2 and rows).
3. Terminate every `queued` or `running` `derived.run_id` of the user's files. The Converter's put step re-reads `library_file` and the owner's status before every R2 write and writes nothing if the row is gone or the owner is `purging`, so a step already past termination cannot recreate objects.
4. Delete R2 objects under `u/<uid>/` in rounds of at most 1,000 keys, then the user's `derived` rows, then `UserLibrary.purge`.
5. In one batch: delete `invite` and `waitlist` rows by the user's `email_norm`, then `DELETE FROM app_user WHERE id = ?` (the cascade removes library, upload, part, passkey, code and challenge rows). Then write the R2 tombstone `purged/<uid>` holding the purge time.
- Rows go last so a crash between steps leaves a row that names what is still to delete (LIB-08).
- **Erasure completes 30 days after the purge**, when Time Travel history ages out. C's privacy text says exactly this (and that DO point-in-time recovery has the same 30 days).
- **Restore runbook (`docs/setup.md`, F):** a Time Travel restore resurrects purged users and signed-out sessions. After any restore, replay the purge for every tombstone newer than the restore point, then run `DELETE FROM phone_session` so every member signs in again.

### Quota (LIB-02): one owner per number, every move guarded
- `quota_bytes` is NULL for every user and means `LIBRARY_QUOTA_BYTES`; a non-NULL value is an admin override. The table carries no default: a 5 GiB column default would restate the config value.
- **`used_bytes`** = `SUM(bytes)` of the user's `library_file` rows with `status IN ('checking', 'ready')`, trash included (a trashed file occupies R2 until purged). A refused file's object is deleted at refusal and does not count. Derived outputs do not count: they are bloop's cost.
- **`reserved_bytes`** = `SUM(bytes)` of the user's `upload` rows with `owner_kind = 'library'`, `completed_at IS NULL` and `aborted_at IS NULL`.
- **Reserve, after R2's create:** one batch. First `INSERT INTO upload ... SELECT ... FROM app_user WHERE id = :u AND status = 'active' AND suspended_at IS NULL AND used_bytes + reserved_bytes + :b <= COALESCE(quota_bytes, :default) AND (SELECT count(*) FROM library_file WHERE user_id = :u) < :maxFiles`, then `UPDATE app_user SET reserved_bytes = reserved_bytes + :b WHERE id = :u AND EXISTS (SELECT 1 FROM upload WHERE id = :id)`. Zero inserts: abort the R2 upload and answer `quota_exceeded` or `library_full`. The row and the reservation commit together or not at all.
- **`LIBRARY_MAX_FILES` (2,000)** bounds one user's rows, so the in-memory name and size sorts and the count stay bounded (a new config variable, F).
- **Complete claims the row first:** `UPDATE upload SET completing_at = :now WHERE id = ? AND completed_at IS NULL AND aborted_at IS NULL AND (completing_at IS NULL OR completing_at < :now - 120000)`. Abort and the expiry sweep carry the same `completing_at` test, so they skip a claim younger than 120 s.
- **Settle, after R2's complete and a head:** if R2's size differs from `upload.bytes`, delete the object and release instead (UP-02). Otherwise one batch, each statement guarded by `completing_at = :claim` and the row still open: move `bytes` from reserved to used, insert the `library_file` row (`status = 'checking'`), close the upload. A stale or concurrent settle changes nothing.
- **Release** (abort, expiry): one batch, the decrement guarded by the row being open and not freshly claimed, then the close.
- **Reconcile, nightly, one statement per user:** `UPDATE app_user SET used_bytes = (<used formula>), reserved_bytes = (<reserved formula>) WHERE id = ?`, logging any drift. It never blocks a user. A direct `used_bytes = ?` anywhere else is a review finding.

### Tables
- **Library rows.** `library_file` holds one row per file, written by the settle batch, with its `version`; `r2_key` names the version (`u/<uid>/<fid>/v<n>/orig`) and is unique. `status` is `checking`, `ready` or `refused`. Trash is `trashed_at` plus `purge_after`; moderation is `disabled_at` plus `disabled_reason`, and disabling a file mails its owner (the "file disabled" template, A). Every library query has `user_id = ?` in its WHERE (LIB-01); `idx_lib_user (user_id, trashed_at, updated_at)` serves both views, the count and the FK cascade.
- **Derived objects** live under `u/<uid>/<fid>/v<n>/d/` (bundle assets) and speaker notes under `u/<uid>/<fid>/v<n>/n/`, a separate prefix the bundle path cannot address (NOTES-01, ADR 0015). No conversion starts while `CONVERT_MODE` is `off`.
- **Uploads, library and guest, share `upload` and `upload_part`.** A guest upload has no `user_id` and carries `screen_ref` and `session_id`. Resume is by `fingerprint` within the owner (`idx_upload_user`, a full index so the FK cascade can use it; `idx_upload_session` for guests). ETags are read only from `upload_part` at complete (UP-08).
- **`derived` has no FK.** Its `file_id` names a library file or a guest file, so a purge deletes its rows explicitly.
- **Moderation and the log outlive their subjects.** `report`, `admin_action` and `hold` have no FK to users or files. A `hold` copy lives under its own R2 prefix (`h/<id>`), never the user's, so an account purge cannot reach it (OSA-02). `admin_action.admin_user_id` survives the admin's own deletion (OSA-05). An `admin_action` row is inserted with the same WHERE predicate as the write it records, so a refused write logs nothing.
- **Sessions** gain `public_id` (128-bit, unique): the only session identifier that leaves D1 (the sessions list, revocation, UserLibrary's screen records). `id_hash` never does.
- **`email_block (email_hash, reason, created_at)`** blocks the address of a closed or banned account. It has no FK and no purge path, so it outlives the account and holds the minimum: `email_hash` is `v1:` plus `HMAC-SHA256(CODE_PEPPER, email_norm)` in hex, never the address. `isBlocked` hashes, then looks up; restore and invite create refuse a blocked address. A pepper rotation keeps the old pepper for `v1:` rows (the address is gone, so they cannot be rehashed); a new pepper writes `v2:` and `isBlocked` checks every live version.
- **Closing an account** (admin) blocks the address, clears `suspended_at` and sets `status = 'deleting'`. The purge claim requires `suspended_at IS NULL` and no live `hold` for the user's files.
- **A library file is never replaced in place:** replacing means delete, then upload. `library_file.version` exists for a conversion, not for a new original.
- **Columns the streams rely on:** `upload.mints` (part URLs minted), `upload.idem_key` with `idx_upload_idem` (the storage adapter of `src/worker/idem.ts`), `library_file.crc32` (written at settle), `hold.bucket` (which bucket the copy came from; the hold row is written before the copy).
- **Settings.** `setting (key, value, updated_at, updated_by)`; ADR 0026 owns the keys. No row is seeded: a missing `launch_mode` reads as `preview`, which keeps one owner (the code default) and fails closed.
- **`guest_file` is rebuilt without its type CHECK**, by the 0003 pattern, and 0004's two `guest_file` indexes are recreated after the rebuild (a rebuild drops them). The two must stay identical to 0004's.

Invite create is an upsert on `idx_invite_open`: it reissues the open row (new token, new expiry, `sends + 1`), so an invite that merely expired never blocks a new one.

### Retention
`email_code` and `auth_challenge` expiry plus 1 day; `upload` and its parts 1 day after closing (`idx_upload_closed`); `invite` expiry plus 90 days (every invite is closed by its expiry at the latest); `waitlist` 90 days after invite or dismissal; `report` 1 year, or 5 years when `nca_ref` is set (an NCA reference is kept 5 years); `admin_action` 2 years; `hold` by `release_after`. Each sweep is bounded per statement (ADR 0006). An account purge also deletes the address's `invite` and `waitlist` rows at once (step 5).

### Indexes
One per query the routes in plan A.4 run, plus every FK child column on a table that grows. Each was checked with `EXPLAIN QUERY PLAN` on node:sqlite with realistic row counts, and the reserve, claim, settle, purge-claim, restore, invite upsert and guarded-log statements were run against the schema. Small, retention-bounded tables (`invite.created_by`, `invite.user_id`) are scanned on an account delete; that is rare and cheap.

### Rollout (F)
Before the remote apply: rehearse 0005 on a copy of the production database (restored from a Time Travel point), check the recreated `guest_file` indexes against 0004 as landed, and confirm a guest insert during the rebuild either lands before it or after it. Record a Time Travel bookmark immediately before the remote apply.

## Rejected
- **A separate `email_user` table:** every FK to `app_user` (sessions, audit, guest passes) would need a union or a second column.
- **`issuer, subject` now:** that is data-hardening's identity migration, which waits for its own ADR; 0005 stays compatible with it: its backfill reads `WHERE tid != 'email'`, and an email row maps to `issuer = 'bloop:email'`, `subject = id`.
- **Suspension as a status value:** it overwrites the deletion marker.
- **A CHECK on status or kind columns:** ADR 0012; a new value would need a table rebuild.
- **Quota as a SUM at upload time:** two concurrent creates both pass; the guarded batch is the serialization point.
- **Reserving before the upload row exists:** a crash between them leaks a reservation for ever.
- **Seeding `launch_mode` in the migration:** a second source for the default.
- **Cascading R2 deletion from D1:** D1 cannot reach R2; rows go last instead.

## Consequences
- One identity table, two providers. Code that reads `app_user.email` for display keeps working; sign-in code reads `email_norm`.
- The retention change and the erase-route change are hard dependencies of 0005.
- Erasure is honest about Time Travel: complete 30 days after the purge, and a restore needs the tombstone replay.
- The data-hardening identity migration must leave email rows alone when it backfills `issuer`.

## Threats served
LIB-01, LIB-02, LIB-08, LIB-09, UP-02, UP-03, UP-08, OSA-02, OSA-05, AUTH-04, MODE-01 (fail-closed default), INV-05 (one open invite per email).

## How to remove it
Accounts off: stop routing `/api/auth/*`, `/api/library*` and `/api/uploads*`, run the purge for every email user, then (expand and contract, ADR 0012) drop the new tables one deploy after no code reads them. `guest_file` keeps its CHECK-free shape.

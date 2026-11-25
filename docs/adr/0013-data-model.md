# ADR 0013: accounts and library data model

Status: proposed. Fable reviews it, with `migrations/0005_accounts_library.sql`, before any code is written against it. It follows ADR 0012 (additive migrations, no enum CHECK) and is amended by ADRs 0014, 0015, 0016 and 0026 only where they name a column.

## Context
- bloop v4 adds invite-only email accounts, a per-user file library in EU R2, direct multipart uploads, converted outputs, moderation, and a launch switch. Every one of them needs D1 rows.
- D1 today has one identity shape: `app_user` keyed by Entra `(tid, oid)`, with `phone_session` and `token_grant` hanging off it by `ON DELETE CASCADE` (`migrations/0001_init.sql`).
- D1 enforces foreign keys. SQLite looks up an FK child row by scanning unless the child column has a usable index, and a partial index does not count.
- The daily job deletes any `app_user` row with no grant, no session and `last_seen_at` older than 30 days (`src/worker/retention.ts`). Written for Entra users who hold nothing, it would delete an email user, and by cascade their library rows, 30 days after their last session ends.
- 0004 (indexes) lands before 0005. Data-hardening's identity and org migration, sketched as its own 0005, becomes 0006 or later (see "Flags").

## Decision
- **Email identities share `app_user`.** An email user is a row with `tid = 'email'` and `oid = id`. An Entra tid is a GUID, so `UNIQUE (tid, oid)` cannot collide. New column `email_norm` (trimmed, Unicode NFC, lowercased whole address, at most 254 characters; no dot or plus folding) has a partial unique index and is NULL for Entra rows. An Entra user and an email user with the same address are two accounts, so no Entra user is ever keyed by email (AUTH-04 holds). Why: every existing FK, the session code and the audit join keep working unchanged.
- **One normalizer.** `email_norm`, `ADMIN_EMAILS`, `TEST_EMAILS`, invites, codes and the waitlist all go through one function in the auth module; the config parse runs the secrets through it too, so a cased entry in a secret still matches.
- **Status, not deletion, carries the account's life.** `status` is `active`, `suspended` or `deleting` (zod only). `delete_after` is the one clock for both inactivity deletion and requested deletion; `status = 'deleting'` marks a requested one. `suspended_at` and `suspended_reason` record suspension. The C auth label (route table, plan A.4) is "session valid and status `active`"; a `deleting` user may reach only `GET /api/me` and `POST /api/me/restore`.
- **Activity clock is the existing `last_seen_at`.** It is set at sign-in and touched at most once a day when a session resolves. Part 2's `last_active_at` is dropped: two clocks for one fact. The inactivity sweep reads `idx_app_user_idle` (`last_seen_at` where `email_norm IS NOT NULL`). Any sign-in or use clears `inactive_warned_at` and an inactivity `delete_after` (one that has `status = 'active'`).
- **The user-row sweep never touches email users.** The retention query gains `AND tid != 'email'` in the same deploy that applies 0005, before the first email user can exist. Email users leave only through the purge below. A test proves an email user with no session survives the sweep (LIB-09).
- **Quota: one owner per number.** `quota_bytes` is NULL for every user and means `LIBRARY_QUOTA_BYTES`; a non-NULL value is an admin override. The DDL default from Part 2 (5 GiB written into the table) is dropped, because it would restate the config value. `used_bytes` counts library originals, trash included (a trashed file still occupies R2 until purged). Derived outputs do not count: they are bloop's cost, not the user's choice.
- **Quota moves by guarded single statements (LIB-02).**
  - Reserve at create: `UPDATE app_user SET reserved_bytes = reserved_bytes + :b WHERE id = :u AND status = 'active' AND used_bytes + reserved_bytes + :b <= COALESCE(quota_bytes, :default)`; zero changes is `quota_exceeded`.
  - Settle at complete, and release at abort or expiry, each in one batch whose first statement moves the bytes guarded by the upload row still being open (`... WHERE EXISTS (SELECT 1 FROM upload WHERE id = :id AND completed_at IS NULL AND aborted_at IS NULL)`), and whose second statement closes the row. A batch is one transaction, so a retried or concurrent settle moves bytes once.
  - A nightly reconcile recomputes `used_bytes` from `library_file` and logs any drift. It never blocks a user.
- **Library rows.** `library_file` holds one row per file with its `version`; `r2_key` names the version (`u/<uid>/<fid>/v<n>/orig`) and is unique. `status` is `uploading`, `checking`, `ready` or `refused`. Trash is `trashed_at` plus `purge_after`; moderation is `disabled_at` plus `disabled_reason`. Every library query has `user_id = ?` in its WHERE (LIB-01), and the index `idx_lib_user (user_id, trashed_at, updated_at)` serves the files view, the trash view and the FK cascade. Name and size sorts read the same user prefix and sort in memory; one user's rows are bounded by the quota.
- **Uploads, library and guest, share `upload` and `upload_part`.** A guest upload has no `user_id` and carries `screen_ref` and `session_id`. Resume is by `fingerprint` within the owner (`idx_upload_user`, a full index so the FK cascade can use it; `idx_upload_session` for guests). ETags are read only from `upload_part` at complete (UP-08).
- **`derived` has no FK.** Its `file_id` names a library file or a guest file, so a purge deletes its rows explicitly, beside the R2 `d/*` prefix.
- **Moderation and the log outlive their subjects.** `report`, `admin_action` and `hold` have no FK to users or files. A `hold` copy lives under its own R2 prefix (`h/<id>`), never the user's, so an account purge cannot reach it (OSA-02). `admin_action.admin_user_id` survives the admin's own deletion (OSA-05).
- **Settings.** `setting (key, value, updated_at, updated_by)`; ADR 0026 owns the keys. No row is seeded: a missing `launch_mode` reads as `preview`, which keeps one owner (the code default) and fails closed.
- **`guest_file` is rebuilt without its type CHECK**, by the 0003 pattern, and 0004's two `guest_file` indexes are recreated after the rebuild (a rebuild drops them). The two must stay identical to 0004's.
- **Account purge order** (the 7-day grace and the inactivity deletion both end here). For one user, idempotent, resumable by the next cron run:
  1. End live screens (`UserLibrary.endScreens`), then delete every session.
  2. Abort open multipart uploads.
  3. Delete R2 objects under `u/<uid>/` in rounds of at most 1,000 keys.
  4. Delete the user's `derived` rows, then `UserLibrary.purge`.
  5. `DELETE FROM app_user WHERE id = ?`: the cascade removes library, upload, part, passkey, code and challenge rows; invites keep their row with `user_id` NULL until their own retention.
  Rows go last so a crash between steps leaves a row that names what is still to delete (LIB-08).
- **Retention per table:** `email_code` and `auth_challenge` expiry plus 1 day; `invite` expiry plus 90 days (every invite is closed by its expiry at the latest, so one index serves it); `waitlist` 90 days after invite or dismissal; `report` 1 year; `admin_action` 2 years; `hold` by `release_after`. Each sweep is bounded per statement (ADR 0006).
- **Indexes:** one per query the routes in plan A.4 run, plus every FK child column on a table that grows. Each was checked with `EXPLAIN QUERY PLAN` against node:sqlite with realistic row counts. Small, retention-bounded tables (`invite.created_by`, `invite.user_id`) are scanned on an account delete; that is rare and cheap.

## Rejected
- **A separate `email_user` table:** every FK to `app_user` (sessions, audit, guest passes) would need a union or a second column.
- **`issuer, subject` now:** that is data-hardening's identity migration, which waits for its own ADR; 0005 stays compatible with it (see "Flags").
- **A CHECK on status or kind columns:** ADR 0012; a new value would need a table rebuild.
- **Quota as a SUM at upload time:** two concurrent creates both pass; the guarded UPDATE is the serialization point.
- **Seeding `launch_mode` in the migration:** a second source for the default.
- **Cascading R2 deletion from D1:** D1 cannot reach R2; rows go last instead.

## Consequences
- One identity table, two providers. Code that reads `app_user.email` for display keeps working; sign-in code reads `email_norm`.
- The retention change is a hard dependency of 0005: if 0005 ships without it, an email user who signs out everywhere loses their account 30 days later.
- Every write path that moves bytes goes through the guarded statements; a direct `used_bytes = ?` outside the reconcile is a review finding.
- The data-hardening identity migration must leave email rows alone when it backfills `issuer` (its sketch updates every row).

## Threats served
LIB-01, LIB-02, LIB-08, LIB-09, UP-03, UP-08, OSA-02, OSA-05, AUTH-04, MODE-01 (fail-closed default), INV-05 (one open invite per email).

## How to remove it
Accounts off: stop routing `/api/auth/*`, `/api/library*` and `/api/uploads*`, run the purge for every email user, then (expand and contract, ADR 0012) drop the new tables one deploy after no code reads them. `guest_file` keeps its CHECK-free shape.

## Flags (Part 2 unsafe, ambiguous or contradicting Part 1, and the resolution)
1. **Unsafe:** the existing user-row sweep would delete email users. Resolved above; the retention edit ships with 0005.
2. **Unsafe:** `idx_invite_open` (unique on email while not accepted and not revoked) blocks every new invite for an email whose invite merely expired. Resolved: creating an invite for an email with an open row reissues that row (new token, new expiry, `sends + 1`), so the index is the guarantee of one live invite per email.
3. **Unsafe:** 0005 rebuilds `guest_file` after 0004 indexes it, silently dropping the indexes. Resolved: recreated at the end of 0005.
4. **Duplicate fact:** Part 2's `quota_bytes DEFAULT 5368709120` restates `LIBRARY_QUOTA_BYTES`. Resolved: NULL means the config value.
5. **Duplicate fact:** Part 2's `last_active_at` beside `last_seen_at`. Resolved: one clock.
6. **Missing:** Part 2's SQL has no `setting` table, which Part 1 needs. Added.
7. **Missing indexes:** Part 2 had no index for the FK cascades (`upload.user_id` was only in a partial-free index with created_at, which no route queries), the admin lists, or the report, admin-log and waitlist retention sweeps. Added; `idx_upload_user` is now `(user_id, fingerprint)`, which serves resume, the open-upload count and the cascade.
8. **Conflict with data-hardening:** both plans claimed 0005. Resolved by Part 1: accounts take 0005. When the identity migration lands, its backfill must read `WHERE tid != 'email'`, and an email row maps to `issuer = 'bloop:email'`, `subject = id`.
9. **Added:** `hold.owner_user_id` and `hold.sha256`, so a hold copy can be matched to its source after the user is erased.

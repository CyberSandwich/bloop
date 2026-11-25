-- Accounts, invites, sign-in, library, uploads, conversion outputs, moderation and the launch setting (ADRs 0013, 0014,
-- 0015, 0026). Additive only (ADR 0012): no column is dropped or renamed, and old code reads every table it knew.
-- Enum columns carry no CHECK: zod in the route is the single check, so a new value never needs a table rebuild.
-- Times are epoch ms. ids are 128-bit random base64url unless noted. *_hash and *_mac columns never hold the secret.
-- Needs 0004 first: phone_session(user_id) and the guest_file indexes below are 0004's.
-- Ships with the retention change that limits the app_user sweep to tid != 'email' (ADR 0013), or that sweep deletes
-- an email user, and by cascade their library rows, 30 days after their last session.

-- Email identities live in app_user beside Entra ones: tid = 'email', oid = id. An Entra tid is a GUID, so the
-- UNIQUE (tid, oid) key cannot collide. email_norm is NULL for Entra rows, so an Entra user and an email user with the
-- same address are two accounts (AUTH-04: an Entra user is never keyed by email).
ALTER TABLE app_user ADD COLUMN email_norm TEXT;                    -- lowercased, NFC, trimmed; the sign-in key
ALTER TABLE app_user ADD COLUMN status TEXT NOT NULL DEFAULT 'active';  -- active | suspended | deleting
ALTER TABLE app_user ADD COLUMN quota_bytes INTEGER;                -- NULL: LIBRARY_QUOTA_BYTES; set only as an override
ALTER TABLE app_user ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0;      -- library originals, trash included
ALTER TABLE app_user ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0;  -- open uploads, released at complete or abort
ALTER TABLE app_user ADD COLUMN inactive_warned_at INTEGER;         -- the 12-month warning went out
ALTER TABLE app_user ADD COLUMN delete_after INTEGER;               -- inactivity or requested deletion runs at this time
ALTER TABLE app_user ADD COLUMN suspended_at INTEGER;
ALTER TABLE app_user ADD COLUMN suspended_reason TEXT;
-- last_seen_at (0001) is the activity clock for email users too: set at sign-in, touched at most daily on use.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_email ON app_user(email_norm) WHERE email_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_user_delete ON app_user(delete_after) WHERE delete_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_user_idle ON app_user(last_seen_at) WHERE email_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_user_created ON app_user(created_at) WHERE email_norm IS NOT NULL;  -- admin list

ALTER TABLE phone_session ADD COLUMN method TEXT;      -- code | passkey | link | entra
ALTER TABLE phone_session ADD COLUMN label TEXT;       -- a coarse client class such as "Safari on iPhone", never the raw UA
ALTER TABLE phone_session ADD COLUMN reauth_at INTEGER;  -- last fresh proof on this session (C+R needs it within REAUTH_SECONDS)

-- Waitlist, filled by the signed Tally webhook. Kept until invited or dismissed, then 90 days.
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY, email_norm TEXT NOT NULL UNIQUE, email TEXT NOT NULL, source TEXT,
  answers TEXT,                                          -- JSON, as Tally sent it, capped by the route
  created_at INTEGER NOT NULL, invited_at INTEGER, dismissed_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_waitlist_open ON waitlist(created_at) WHERE invited_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_waitlist_closed ON waitlist(COALESCE(invited_at, dismissed_at))
  WHERE invited_at IS NOT NULL OR dismissed_at IS NOT NULL;

-- Invites (ADR 0014). token_hash = SHA-256 of a 256-bit token that lives only in the link's fragment. One open row per
-- email: create on an email that already has an open row (expired or not) reissues that row instead of inserting.
CREATE TABLE IF NOT EXISTS invite (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email_norm TEXT NOT NULL, email TEXT NOT NULL,
  note TEXT,
  created_by TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  waitlist_id TEXT REFERENCES waitlist(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_sent_at INTEGER, sends INTEGER NOT NULL DEFAULT 0,
  accepted_at INTEGER, user_id TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  revoked_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_open ON invite(email_norm) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invite_created ON invite(created_at);   -- admin list, newest first
CREATE INDEX IF NOT EXISTS idx_invite_expires ON invite(expires_at);   -- retention: every row is closed by its expiry
CREATE INDEX IF NOT EXISTS idx_invite_waitlist ON invite(waitlist_id) WHERE waitlist_id IS NOT NULL;  -- FK on waitlist sweep

-- One-time email codes (ADR 0014). code_mac = HMAC-SHA256(CODE_PEPPER, id|purpose|email_norm|code). A request for an
-- email that is not a member still writes a row (with a MAC of a code nobody holds), so known and unknown emails cost
-- the same work (AUTH-10). Purposes: signin | invite | email_change | reauth | link.
CREATE TABLE IF NOT EXISTS email_code (
  id TEXT PRIMARY KEY, email_norm TEXT NOT NULL, purpose TEXT NOT NULL,
  user_id TEXT REFERENCES app_user(id) ON DELETE CASCADE,
  invite_id TEXT REFERENCES invite(id) ON DELETE CASCADE,
  new_email_norm TEXT,                                  -- email_change only: the address the code went to
  code_mac TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_email_code_email ON email_code(email_norm, created_at);  -- per-email limits, supersede
CREATE INDEX IF NOT EXISTS idx_email_code_expires ON email_code(expires_at);
CREATE INDEX IF NOT EXISTS idx_email_code_user ON email_code(user_id) WHERE user_id IS NOT NULL;      -- FK cascade
CREATE INDEX IF NOT EXISTS idx_email_code_invite ON email_code(invite_id) WHERE invite_id IS NOT NULL;  -- FK cascade

-- WebAuthn credentials. id is the credential id (base64url), unique across authenticators by spec.
CREATE TABLE IF NOT EXISTS passkey (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL, sign_count INTEGER NOT NULL, transports TEXT, aaguid TEXT,
  backed_up INTEGER NOT NULL, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey(user_id);

-- WebAuthn ceremonies: single use (deleted by the verify that reads it), 5 minutes, bound to the browser that started
-- them by binder_hash = SHA-256 of a value in a short-lived __Host- cookie. Purposes: signin | register | reauth.
CREATE TABLE IF NOT EXISTS auth_challenge (
  id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL,
  user_id TEXT REFERENCES app_user(id) ON DELETE CASCADE,
  binder_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_auth_challenge_expires ON auth_challenge(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_challenge_user ON auth_challenge(user_id) WHERE user_id IS NOT NULL;  -- FK cascade

-- The library (ADR 0016). One row per file; version bumps when the original is replaced, and r2_key names the version
-- (u/<uid>/<fid>/v<n>/orig). Status: uploading | checking | ready | refused. Trashed files still count in used_bytes.
CREATE TABLE IF NOT EXISTS library_file (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT,
  version INTEGER NOT NULL DEFAULT 1, r2_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, refusal TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_presented_at INTEGER, selected_at INTEGER,
  trashed_at INTEGER, purge_after INTEGER,
  disabled_at INTEGER, disabled_reason TEXT);
-- Serves the files view (trashed_at IS NULL) and the trash view (IS NOT NULL) sorted by updated_at, and the FK cascade.
-- Name and size sorts read the same user prefix and sort in memory: one user's rows are bounded by the quota.
CREATE INDEX IF NOT EXISTS idx_lib_user ON library_file(user_id, trashed_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_lib_selected ON library_file(user_id, selected_at) WHERE selected_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lib_purge ON library_file(purge_after) WHERE purge_after IS NOT NULL;

-- Multipart uploads, library and guest alike (ADR 0017). owner_kind: library | guest; bucket: library | guest.
-- A guest upload has no user_id and carries screen_ref and session_id instead. ETags come only from upload_part.
CREATE TABLE IF NOT EXISTS upload (
  id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL,
  user_id TEXT REFERENCES app_user(id) ON DELETE CASCADE,
  screen_ref TEXT, session_id TEXT,
  file_id TEXT NOT NULL, bucket TEXT NOT NULL, r2_key TEXT NOT NULL, r2_upload_id TEXT NOT NULL,
  name TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL,
  part_bytes INTEGER NOT NULL, parts INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,                             -- client SHA-256 over name, size and sampled bytes: the resume key
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  completed_at INTEGER, aborted_at INTEGER);
-- Full, not partial, so the FK cascade from app_user can use it; resume and the open-upload count add the IS NULL tests.
CREATE INDEX IF NOT EXISTS idx_upload_user ON upload(user_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_upload_session ON upload(session_id, fingerprint) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_upload_open ON upload(expires_at) WHERE completed_at IS NULL AND aborted_at IS NULL;

CREATE TABLE IF NOT EXISTS upload_part (
  upload_id TEXT NOT NULL REFERENCES upload(id) ON DELETE CASCADE, n INTEGER NOT NULL,
  etag TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, n));

-- Converter outputs per file version (ADR 0019). No FK: file_id names a library_file or a guest session's file, and a
-- purge deletes these rows itself. Status: queued | running | done | failed | skipped. outputs is the validated manifest.
CREATE TABLE IF NOT EXISTS derived (
  file_id TEXT NOT NULL, version INTEGER NOT NULL, owner_kind TEXT NOT NULL,
  status TEXT NOT NULL, stage TEXT,
  pages INTEGER, has_notes INTEGER, has_motion INTEGER, fonts_missing TEXT,
  outputs TEXT, bytes INTEGER, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, workflow_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, version));
CREATE INDEX IF NOT EXISTS idx_derived_status ON derived(status, updated_at);  -- stuck-job sweep

-- Moderation (ADR 0024). Reports kept 1 year. channel: screen | phone | site | email; status: open | resolved.
CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, channel TEXT NOT NULL,
  session_id TEXT, file_id TEXT,                         -- the server maps a reported session to its file ids
  reporter_email TEXT, category TEXT NOT NULL, detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', resolved_at INTEGER, resolution TEXT);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(status, created_at);
CREATE INDEX IF NOT EXISTS idx_report_created ON report(created_at);   -- retention

-- Every admin action and every launch-gate tick (ADR 0026), kept 2 years. No FK on admin_user_id: the log outlives the
-- admin's account. target_kind: user | file | invite | waitlist | report | setting.
CREATE TABLE IF NOT EXISTS admin_action (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, admin_user_id TEXT, action TEXT NOT NULL,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, report_id TEXT);
CREATE INDEX IF NOT EXISTS idx_admin_target ON admin_action(target_kind, target_id, at);
CREATE INDEX IF NOT EXISTS idx_admin_at ON admin_action(at);           -- retention

-- NCA hold copies: 1 year, outside every lifecycle and every user purge. No FKs, so erasing the owner or the file
-- leaves the hold. r2_key is the copy's own key (h/<id>), never the user's prefix.
CREATE TABLE IF NOT EXISTS hold (
  id TEXT PRIMARY KEY, file_id TEXT NOT NULL, owner_user_id TEXT, r2_key TEXT NOT NULL, sha256 TEXT,
  report_id TEXT, created_at INTEGER NOT NULL, release_after INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hold_file ON hold(file_id);
CREATE INDEX IF NOT EXISTS idx_hold_release ON hold(release_after);

-- Runtime settings changed only from /admin (ADR 0026). Keys: launch_mode (preview | open) and gate.ico, gate.osa,
-- gate.legal ('1' when ticked). No row is seeded: a missing launch_mode reads as preview.
CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);

-- guest_file loses its type CHECK, so a new guest type is a zod change, not a rebuild. Same pattern as
-- migrations/0003_guest_file_images.sql; nothing references guest_file. A rebuild drops the table's indexes, so 0004's
-- two are recreated here; keep them identical to 0004's.
CREATE TABLE guest_file_new (
  session_id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, bytes INTEGER NOT NULL,
  type TEXT NOT NULL, sha256 TEXT NOT NULL,
  name TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
INSERT INTO guest_file_new (session_id, r2_key, bytes, type, sha256, name, created_at, deleted_at)
  SELECT session_id, r2_key, bytes, type, sha256, name, created_at, deleted_at FROM guest_file;
DROP TABLE guest_file;
ALTER TABLE guest_file_new RENAME TO guest_file;
CREATE INDEX IF NOT EXISTS idx_guest_file_live ON guest_file(created_at, bytes) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guest_file_deleted ON guest_file(deleted_at) WHERE deleted_at IS NOT NULL;

PRAGMA optimize;

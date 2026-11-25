-- Indexes for the queries the cron jobs, the account routes and the retention purge run (ADR 0012: additive only).
-- Before this file migrations/ held no CREATE INDEX, so every purge below scanned its table. Needs nothing from 0005;
-- 0005 needs idx_phone_session_user and recreates the two guest_file indexes after its rebuild, identical to these.
CREATE INDEX IF NOT EXISTS idx_audit_event_at ON audit_event(at);
CREATE INDEX IF NOT EXISTS idx_audit_event_session_at ON audit_event(session_id, at);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_claimed ON session(claimed_at);
CREATE INDEX IF NOT EXISTS idx_session_open ON session(claimed_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_phone_session_user ON phone_session(user_id);
CREATE INDEX IF NOT EXISTS idx_phone_session_expires ON phone_session(expires_at);
CREATE INDEX IF NOT EXISTS idx_phone_session_seen ON phone_session(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_token_grant_updated ON token_grant(updated_at);
CREATE INDEX IF NOT EXISTS idx_metric_event_at ON metric_event(at);
CREATE INDEX IF NOT EXISTS idx_guest_file_live ON guest_file(created_at, bytes) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guest_file_deleted ON guest_file(deleted_at) WHERE deleted_at IS NOT NULL;
PRAGMA optimize;

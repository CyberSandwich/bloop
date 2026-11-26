-- The hourly upload sweep finds library files left `checking`, and files it refused, by status and age (ADR 0012: additive only).
CREATE INDEX IF NOT EXISTS idx_library_file_status ON library_file(status, updated_at);

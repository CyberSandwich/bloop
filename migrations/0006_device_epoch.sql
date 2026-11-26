-- The known-device epoch (ADR 0014): it is in the known-device MAC, so moving it (sign out everywhere, ending one
-- session, a passkey removal, a deletion request) refuses every device value issued before, on every device. Additive only (ADR 0012).
ALTER TABLE app_user ADD COLUMN device_epoch INTEGER NOT NULL DEFAULT 0;

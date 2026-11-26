-- A hold is "pending" until its copy exists, and the purge claim reads that in one statement (OSA-02): copied_at is
-- NULL from the row's insert until the copy is made. Rows that predate the column stay NULL: the old order could leave a
-- row with no copy, so holdFiles settles each by looking for its copy rather than this file assuming one.
ALTER TABLE hold ADD COLUMN copied_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_hold_owner ON hold(owner_user_id);

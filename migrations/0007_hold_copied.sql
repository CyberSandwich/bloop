-- A hold is "pending" until its copy exists, and the purge claim reads that in one statement (OSA-02): copied_at is
-- NULL from the row's insert until the copy is made. Rows that predate the column were copied by the old order.
ALTER TABLE hold ADD COLUMN copied_at INTEGER;
UPDATE hold SET copied_at = created_at;
CREATE INDEX IF NOT EXISTS idx_hold_owner ON hold(owner_user_id);

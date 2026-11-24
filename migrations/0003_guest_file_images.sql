-- guest_file.type also admits the image and video types a guest may drop (jpg, png, mp4, mov). D1 has no ALTER of a
-- CHECK, so the table is rebuilt: create the new shape, copy every row, drop the old table, rename. Nothing
-- references guest_file.
CREATE TABLE guest_file_new (
  session_id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, bytes INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('pptx','pdf','jpg','png','mp4','mov')), sha256 TEXT NOT NULL,
  name TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
INSERT INTO guest_file_new (session_id, r2_key, bytes, type, sha256, name, created_at, deleted_at)
  SELECT session_id, r2_key, bytes, type, sha256, name, created_at, deleted_at FROM guest_file;
DROP TABLE guest_file;
ALTER TABLE guest_file_new RENAME TO guest_file;

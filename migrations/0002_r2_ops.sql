-- R2 operations bloop performed, per calendar month (UTC, 'YYYY-MM') and billing class ('A' writes and lists, 'B' reads and heads).
-- Incremented before the R2 call so a refusal happens first; the daily retention job keeps 13 months.
CREATE TABLE r2_ops (
  month TEXT NOT NULL, class TEXT NOT NULL CHECK (class IN ('A','B')), n INTEGER NOT NULL,
  PRIMARY KEY (month, class));

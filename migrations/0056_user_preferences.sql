-- Account-level preferences shared by every client. One row per preference so
-- new preferences never need another migration. user_id has no foreign key:
-- instances running without authentication store the owner under "local".
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Explicit local candidate only. Not loaded by production migration/startup.
CREATE TABLE ee_table_heads (
 workspace_id TEXT NOT NULL,
 table_id TEXT NOT NULL UNIQUE REFERENCES memos(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 schema_revision INTEGER NOT NULL,
 row_count INTEGER NOT NULL,
 max_position INTEGER NOT NULL,
 header_json TEXT NOT NULL CHECK(json_valid(header_json)),
 indexes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(indexes_json)),
 lock_job_id TEXT,
 PRIMARY KEY(workspace_id,table_id)
);
CREATE TABLE ee_table_commits (
 workspace_id TEXT NOT NULL, table_id TEXT NOT NULL, revision INTEGER NOT NULL,
 schema_revision INTEGER NOT NULL, row_count INTEGER NOT NULL, max_position INTEGER NOT NULL,
 header_json TEXT NOT NULL CHECK(json_valid(header_json)),
 PRIMARY KEY(workspace_id,table_id,revision),
 FOREIGN KEY(workspace_id,table_id) REFERENCES ee_table_heads(workspace_id,table_id) ON DELETE CASCADE
);
CREATE TABLE ee_table_records (
 id INTEGER PRIMARY KEY,
 workspace_id TEXT NOT NULL, table_id TEXT NOT NULL,
 record_id TEXT NOT NULL, position INTEGER NOT NULL, created_revision INTEGER NOT NULL,
 cells_json TEXT NOT NULL CHECK(json_valid(cells_json)),
 normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)), search_text TEXT NOT NULL,
 UNIQUE(workspace_id,table_id,record_id), UNIQUE(workspace_id,table_id,position),
 FOREIGN KEY(workspace_id,table_id) REFERENCES ee_table_heads(workspace_id,table_id) ON DELETE CASCADE
);
CREATE TABLE ee_table_versions (
 workspace_id TEXT NOT NULL, table_id TEXT NOT NULL, record_id TEXT NOT NULL,
 revision INTEGER NOT NULL, position INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
 cells_json TEXT NOT NULL CHECK(json_valid(cells_json)),
 PRIMARY KEY(workspace_id,table_id,record_id,revision),
 FOREIGN KEY(workspace_id,table_id) REFERENCES ee_table_heads(workspace_id,table_id) ON DELETE CASCADE
);
CREATE INDEX ee_table_versions_position ON ee_table_versions(workspace_id,table_id,position,revision DESC);
CREATE TABLE ee_table_assertion (ok INTEGER PRIMARY KEY CHECK(ok=1));
CREATE VIRTUAL TABLE ee_table_search USING fts5(search_text,content='ee_table_records',content_rowid='id');
CREATE TRIGGER ee_table_search_insert AFTER INSERT ON ee_table_records BEGIN
 INSERT INTO ee_table_search(rowid,search_text) VALUES(NEW.id,NEW.search_text);
END;
CREATE TRIGGER ee_table_search_update AFTER UPDATE OF search_text ON ee_table_records BEGIN
 INSERT INTO ee_table_search(ee_table_search,rowid,search_text) VALUES('delete',OLD.id,OLD.search_text);
 INSERT INTO ee_table_search(rowid,search_text) VALUES(NEW.id,NEW.search_text);
END;
CREATE TRIGGER ee_table_search_delete AFTER DELETE ON ee_table_records BEGIN
 INSERT INTO ee_table_search(ee_table_search,rowid,search_text) VALUES('delete',OLD.id,OLD.search_text);
END;
CREATE TABLE ee_table_type_jobs (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, table_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL, field_id TEXT NOT NULL,
 target_json TEXT NOT NULL CHECK(json_valid(target_json)),
 header_json TEXT NOT NULL CHECK(json_valid(header_json)),
 state TEXT NOT NULL CHECK(state IN ('preflight','running','ready','published','cancelled')),
 failures_json TEXT NOT NULL DEFAULT '[]', confirmations_json TEXT NOT NULL DEFAULT '[]',
 after_position INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(workspace_id,table_id) REFERENCES ee_table_heads(workspace_id,table_id) ON DELETE CASCADE
);
CREATE TABLE ee_table_type_values (
 job_id TEXT NOT NULL REFERENCES ee_table_type_jobs(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL, position INTEGER NOT NULL,
 cells_json TEXT NOT NULL CHECK(json_valid(cells_json)),
 normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)), search_text TEXT NOT NULL,
 PRIMARY KEY(job_id,record_id), UNIQUE(job_id,position)
);

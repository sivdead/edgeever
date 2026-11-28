-- Match the opening HTML comment and ECMAScript whitespace used by TABLE_COMMENT.
-- Byte slices preserve markers after embedded NULs in a legacy Markdown fallback.
CREATE VIEW ee_table_marked_memos AS
SELECT c.memo_id FROM memo_contents c
WHERE instr(c.content_markdown,'edgeever-table-v1:')>0 AND EXISTS (
  WITH RECURSIVE
  token(bytes) AS (SELECT CAST('edgeever-table-v1:' AS BLOB)),
  source(body) AS (SELECT CAST(c.content_markdown AS BLOB)),
  markers(prefix,tail) AS (
    SELECT substr(body,1,instr(body,bytes)-1),substr(body,instr(body,bytes)+length(bytes))
      FROM source,token
    UNION ALL
    SELECT substr(tail,1,instr(tail,bytes)-1),substr(tail,instr(tail,bytes)+length(bytes))
      FROM markers,token WHERE instr(tail,bytes)>0
  )
  SELECT 1 FROM markers WHERE
    substr(CAST(rtrim(CAST(prefix AS TEXT),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS BLOB),-4)=CAST('<!--' AS BLOB)
    AND instr(tail,CAST('-->' AS BLOB))>0
);

DROP TRIGGER ee_table_active_guard_insert;
DROP TRIGGER ee_table_active_guard_update;
CREATE TRIGGER ee_table_active_guard_insert AFTER INSERT ON memo_contents WHEN NEW.shared_table_revision IS NULL AND EXISTS (SELECT 1 FROM ee_table_activation WHERE id=1) AND EXISTS (SELECT 1 FROM ee_table_marked_memos WHERE memo_id=NEW.memo_id) BEGIN SELECT RAISE(ABORT,'table_migration_in_progress'); END;
CREATE TRIGGER ee_table_active_guard_update AFTER UPDATE OF content_markdown ON memo_contents WHEN NEW.content_markdown IS NOT OLD.content_markdown AND NEW.shared_table_revision IS OLD.shared_table_revision AND EXISTS (SELECT 1 FROM ee_table_activation WHERE id=1) AND (OLD.shared_table_revision IS NOT NULL OR EXISTS (SELECT 1 FROM ee_table_marked_memos WHERE memo_id=NEW.memo_id)) BEGIN SELECT RAISE(ABORT,'table_migration_in_progress'); END;

DROP VIEW memo_contents_for_read;
CREATE VIEW memo_contents_for_read AS
SELECT c.memo_id, c.content_json, c.content_markdown, c.content_text, c.content_hash,
       c.revision, c.created_at, c.updated_at,
       c.shared_table_revision AS stored_shared_table_revision,
       COALESCE(c.shared_table_revision, h.revision) AS shared_table_revision
FROM memo_contents c
LEFT JOIN ee_table_activation a ON a.id = 1 AND c.shared_table_revision IS NULL
LEFT JOIN ee_table_heads h ON h.table_id = c.memo_id AND h.migration_run_id = a.run_id
  AND EXISTS (SELECT 1 FROM ee_table_marked_memos t WHERE t.memo_id=c.memo_id);

-- Capture candidate writes cheaply. Replay parses the actual body.
DROP TRIGGER ee_table_migration_track_insert;
DROP TRIGGER ee_table_migration_track_update;
DROP TRIGGER ee_table_migration_track_delete;
CREATE TRIGGER ee_table_migration_track_insert AFTER INSERT ON memo_contents WHEN EXISTS (SELECT 1 FROM ee_table_migration WHERE id=1 AND phase<>'rolling_back') AND instr(NEW.content_markdown,'edgeever-table-v1:')>0 BEGIN INSERT INTO ee_table_migration_dirty(memo_id,before_markdown) VALUES(NEW.memo_id,'') ON CONFLICT(memo_id) DO NOTHING; END;
CREATE TRIGGER ee_table_migration_track_update AFTER UPDATE OF content_markdown ON memo_contents WHEN NEW.content_markdown IS NOT OLD.content_markdown AND EXISTS (SELECT 1 FROM ee_table_migration WHERE id=1 AND phase<>'rolling_back') AND (instr(OLD.content_markdown,'edgeever-table-v1:')>0 OR instr(NEW.content_markdown,'edgeever-table-v1:')>0) BEGIN INSERT INTO ee_table_migration_dirty(memo_id,before_markdown) VALUES(NEW.memo_id,OLD.content_markdown) ON CONFLICT(memo_id) DO NOTHING; END;
CREATE TRIGGER ee_table_migration_track_delete AFTER DELETE ON memo_contents WHEN EXISTS (SELECT 1 FROM ee_table_migration WHERE id=1 AND phase<>'rolling_back') AND instr(OLD.content_markdown,'edgeever-table-v1:')>0 BEGIN INSERT INTO ee_table_migration_dirty(memo_id,before_markdown) VALUES(OLD.memo_id,OLD.content_markdown) ON CONFLICT(memo_id) DO NOTHING; END;

-- Only insufficient claims insert a row. The named constraint aborts the batch.
CREATE TABLE ee_table_migration_space_guard (
  remaining_bytes INTEGER CONSTRAINT table_migration_budget_exhausted CHECK(remaining_bytes >= 0)
);

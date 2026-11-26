import {
  createExcerpt,
  docToText,
  hasTableDocumentMarker,
  markdownToDoc,
  parseTableDocument,
  serializeTableDocument,
  tableFallbackMarkdown,
} from "@edgeever/shared";
import { AppError } from "./app-error";
import { isoNow, parseJsonArray } from "./entity-utils";
import { sha256 } from "./hash-utils";
import { upsertMemoSearchDocumentStatement } from "./memo-search-index";
import {
  createMemoRevisionStatement,
  type MemoRevisionSourceRow,
} from "./memo-revision-service";
import { SharedTableStore, type SharedHead } from "./shared-table-store";
import type { SharedFieldIndex } from "./shared-table-index";
import type {
  DatabaseAdapter,
  PreparedStatementAdapter,
} from "./storage-contract";
import { tableStatement } from "./table-query-sql";

const MEMO_BATCH = 50;
const RECORD_BATCH = 25;

type ProgressRow = {
  phase: "copying" | "ready" | "rolling_back";
  run_id: string;
  after_memo_id: string;
  pending_ids: string;
  after_position: number;
  tables_copied: number;
  rows_copied: number;
  step: number;
};

type LegacySource = {
  id: string;
  workspace_id: string;
  content_markdown: string;
};

const progress = (row: ProgressRow | null) => ({
  phase: row?.phase ?? "legacy",
  tablesCopied: row?.tables_copied ?? 0,
  rowsCopied: row?.rows_copied ?? 0,
  tableId: row ? ((JSON.parse(row.pending_ids) as string[])[0] ?? null) : null,
  afterPosition: row?.after_position ?? 0,
});

export class SharedTableMigration {
  private readonly sql: ReturnType<typeof tableStatement>;
  private readonly store: SharedTableStore;

  constructor(private readonly db: DatabaseAdapter) {
    this.sql = tableStatement(db);
    this.store = new SharedTableStore(db);
  }

  private state() {
    return this
      .sql`SELECT * FROM ee_table_migration WHERE id = 1`.first<ProgressRow>();
  }

  async status() {
    const active = await this.sql`SELECT tables_copied, rows_copied FROM ee_table_activation WHERE id = 1`
      .first<{ tables_copied: number; rows_copied: number }>();
    return active ? { phase: "active" as const, tablesCopied: active.tables_copied, rowsCopied: active.rows_copied, tableId: null, afterPosition: 0 }
      : progress(await this.state());
  }

  async activate() {
    await this.db.batch([
      this.sql`INSERT INTO ee_table_activation(id, run_id, tables_copied, rows_copied)
        SELECT id, run_id, tables_copied, rows_copied FROM ee_table_migration WHERE id = 1 AND phase = 'ready'`,
      this.sql`DELETE FROM ee_table_migration WHERE id = 1 AND phase = 'ready'`,
    ]);
    const status = await this.status();
    if (status.phase !== "active") throw new AppError("table_migration_not_ready", "Finish verifying the table migration before activation", 409);
    return status;
  }

  async start() {
    await this
      .sql`INSERT INTO ee_table_migration(id, run_id, phase) SELECT 1, ${crypto.randomUUID()}, 'copying' WHERE NOT EXISTS (SELECT 1 FROM ee_table_activation WHERE id = 1) ON CONFLICT(id) DO NOTHING`.run();
    return this.status();
  }

  async beginRollback() {
    await this
      .sql`UPDATE ee_table_migration SET phase = 'rolling_back', step = step + 1 WHERE id = 1 AND phase <> 'rolling_back'`.run();
    return this.status();
  }

  async advance() {
    const state = await this.state();
    if (!state) return this.status();
    if (state.phase === "ready") return progress(state);
    if (state.phase === "rolling_back") return this.rollback(state);

    const pending = JSON.parse(state.pending_ids) as string[];
    const tableId = pending[0];
    if (tableId) {
      const source = await this
        .sql`SELECT m.id, m.workspace_id, mc.content_markdown
        FROM memos m JOIN memo_contents mc ON mc.memo_id = m.id WHERE m.id = ${tableId}`.first<LegacySource>();
      if (!source)
        throw new AppError(
          "invalid_legacy_table",
          `Cannot read table ${tableId}`,
          409,
        );
      const remaining = JSON.stringify(pending.slice(1));
      if (hasTableDocumentMarker(source.content_markdown))
        return this.copy(state, source, remaining);
      return this.commit(state, [
        this
          .sql`UPDATE ee_table_migration SET pending_ids = ${remaining}, step = step + 1 WHERE id = 1`,
      ]);
    }

    const page = (
      await this
        .sql`SELECT m.id, mc.content_markdown GLOB '*<!--*edgeever-table-v1:*-->*' AS table_marker
      FROM memos m JOIN memo_contents mc ON mc.memo_id = m.id WHERE m.id > ${state.after_memo_id}
      ORDER BY m.id LIMIT ${MEMO_BATCH}`.all<{
        id: string;
        table_marker: number;
      }>()
    ).results;
    const candidates = page
      .filter((row) => row.table_marker)
      .map((row) => row.id);
    const phase =
      page.length < MEMO_BATCH && candidates.length === 0 ? "ready" : "copying";
    const afterMemoId = page.at(-1)?.id ?? state.after_memo_id;
    return this.commit(state, [
      this
        .sql`UPDATE ee_table_migration SET phase = ${phase}, after_memo_id = ${afterMemoId},
        pending_ids = ${JSON.stringify(candidates)}, step = step + 1 WHERE id = 1`,
    ]);
  }

  private copy(state: ProgressRow, source: LegacySource, remaining: string) {
    const document = parseTableDocument(source.content_markdown);
    if (!document)
      throw new AppError(
        "invalid_legacy_table",
        `Cannot parse table ${source.id}`,
        409,
      );

    const { statements, end } = this.store.stageLegacyBatch(
      source.workspace_id,
      source.id,
      document,
      state.after_position,
      RECORD_BATCH,
      state.run_id,
    );
    const copied = end - state.after_position;
    const complete = end === document.records.length;
    statements.push(this.sql`UPDATE ee_table_migration SET
      pending_ids = ${complete ? remaining : state.pending_ids}, after_position = ${complete ? 0 : end},
      rows_copied = rows_copied + ${copied}, tables_copied = tables_copied + ${Number(complete)}, step = step + 1 WHERE id = 1`);
    return this.commit(state, statements);
  }

  private async rollback(state: ProgressRow) {
    const head = await this
      .sql`SELECT * FROM ee_table_heads WHERE migration_run_id = ${state.run_id} ORDER BY table_id LIMIT 1`.first<SharedHead>();
    if (!head)
      return this.commit(state, [
        this.sql`DELETE FROM ee_table_migration WHERE id = 1`,
      ]);

    const statements = [
      this.sql`INSERT INTO ee_table_assertion SELECT 0 WHERE NOT EXISTS (
        SELECT 1 FROM ee_table_heads WHERE table_id = ${head.table_id} AND migration_run_id = ${state.run_id} AND revision = ${head.revision})`,
    ];
    if (head.revision > 1)
      statements.push(...(await this.restoreLegacyBody(state, head)));
    const indexes = JSON.parse(head.indexes_json) as SharedFieldIndex[];
    statements.push(
      ...indexes.map((index) => this.db.prepare(`DROP INDEX ${index.name}`)),
      this
        .sql`DELETE FROM ee_table_heads WHERE table_id = ${head.table_id} AND migration_run_id = ${state.run_id}`,
      this
        .sql`UPDATE ee_table_migration SET write_back_id = NULL, step = step + 1 WHERE id = 1`,
    );
    return this.commit(state, statements);
  }

  private async restoreLegacyBody(state: ProgressRow, head: SharedHead) {
    const memo = await this
      .sql`SELECT m.id,m.title,m.tags_json,mc.revision,mc.content_json,mc.content_markdown,mc.content_text,mc.content_hash
      FROM memos m JOIN memo_contents mc ON mc.memo_id = m.id WHERE m.id = ${head.table_id} AND m.workspace_id = ${head.workspace_id}`.first<MemoRevisionSourceRow>();
    if (!memo)
      throw new AppError(
        "invalid_legacy_table",
        `Cannot read table ${head.table_id}`,
        409,
      );
    const document = await this.store.migrationSnapshot(head, state.run_id);
    const { cellEncoding: _encoding, ...legacy } = document;
    const markdown = serializeTableDocument(legacy);
    const roundTrip = parseTableDocument(markdown);
    // Field reorder changes JSON property order without changing cell values.
    const ordered = {
      ...legacy,
      records: legacy.records.map((row) => ({
        id: row.id,
        cells: Object.fromEntries(
          legacy.fields.map((field) => [field.id, row.cells[field.id]]),
        ),
      })),
    };
    if (!roundTrip || JSON.stringify(roundTrip) !== JSON.stringify(ordered)) {
      throw new AppError(
        "legacy_rollback_incompatible",
        `Table ${head.table_id} has values that cannot round-trip through the legacy format`,
        409,
      );
    }

    const doc = markdownToDoc(tableFallbackMarkdown(legacy));
    const json = JSON.stringify(doc);
    const contentText = docToText(doc);
    const contentHash = await sha256(markdown + json);
    const now = isoNow();
    return [
      this
        .sql`UPDATE ee_table_migration SET write_back_id = ${memo.id} WHERE id = 1`,
      createMemoRevisionStatement(this.db, memo, "table-storage-rollback", now),
      this
        .sql`UPDATE memo_contents SET content_markdown = ${markdown}, content_json = ${json}, content_text = ${contentText},
        content_hash = ${contentHash}, revision = revision + 1, updated_at = ${now} WHERE memo_id = ${memo.id}`,
      this
        .sql`UPDATE memos SET excerpt = ${createExcerpt(contentText)}, updated_at = ${now} WHERE id = ${memo.id}`,
      upsertMemoSearchDocumentStatement(
        this.db,
        memo.id,
        memo.title ?? "",
        contentText,
        parseJsonArray(memo.tags_json).join(" "),
      ),
    ];
  }

  private async commit(
    state: ProgressRow,
    statements: PreparedStatementAdapter[],
  ) {
    try {
      await this.db.batch([
        this.sql`INSERT INTO ee_table_assertion SELECT 0 WHERE NOT EXISTS (
          SELECT 1 FROM ee_table_migration WHERE id = 1 AND run_id = ${state.run_id} AND phase = ${state.phase} AND step = ${state.step})`,
        ...statements,
      ]);
    } catch (error) {
      const latest = await this.state();
      if (latest?.run_id !== state.run_id || latest.step !== state.step)
        return progress(latest);
      throw error;
    }
    return this.status();
  }
}

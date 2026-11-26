import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docToText, markdownToDoc, parseTableDocument, serializeTableDocument } from "@edgeever/shared";
import { createMemoRecord, getMemoDetail, getMemoDetailRow, mapMemoDetail, updateMemoRecord } from "./memo-service";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter";
import { listMemoRevisions, restoreMemoRevision } from "./memo-revision-service";
import { SharedTableStore } from "./shared-table-store";
import { sha256 } from "./hash-utils";
import { appendTableFormSubmission } from "./table-form-service";
import { registerSharedTableRoutes } from "./shared-table-routes";
import { registerSyncRoutes } from "./sync-routes";
import { registerBackupRoutes } from "./backup-routes";
import { restoreJsonMemos } from "./backup-service";
import { SharedTableMigration } from "./table-storage-migration";

const actor = { actorType: "user", actorId: "usr_owner" };
const workspace = "ws_default";
const fields = [
  { id: "name", name: "Name", type: "text" },
  { id: "files", name: "Files", type: "attachment" },
];
const records = Array.from({ length: 117 }, (_, i) => ({
  id: `row_${117 - i}`,
  cells: {
    name: `Task ${i}`,
    files:
      i === 0
        ? [
            {
              resourceId: "res_test",
              filename: "附件.pdf",
              mimeType: "application/pdf",
              byteSize: 7,
            },
          ]
        : [],
  },
}));
const tables = [
  { schemaVersion: 1, fields, records, view: { filters: [], sort: null } },
  {
    schemaVersion: 2,
    fields,
    records: records.slice(0, 2),
    views: [
      { id: "view_a", name: "My view", match: "all", filters: [], sorts: [] },
    ],
  },
];

async function seedLegacyMemo(db, document, id) {
  const contentMarkdown = serializeTableDocument(document);
  const doc = markdownToDoc(contentMarkdown);
  const contentJson = JSON.stringify(doc);
  const contentHash = await sha256(contentMarkdown + contentJson);
  await db.batch([
    db.prepare("INSERT INTO memos (id, workspace_id, notebook_id, title) VALUES (?, ?, 'nb_inbox', 'Fixture')").bind(id, workspace),
    db.prepare("INSERT INTO memo_contents (memo_id, content_markdown, content_json, content_text, content_hash, revision) VALUES (?, ?, ?, ?, ?, 0)")
      .bind(id, contentMarkdown, contentJson, docToText(doc), contentHash),
  ]);
  return { id, contentMarkdown, contentHash, revision: 0 };
}

async function seededInstallation() {
  const directory = mkdtempSync(join(tmpdir(), "edgeever-table-migration-"));
  const path = join(directory, "data.sqlite");
  const open = () => {
    const sqlite = new Database(path);
    sqlite.exec("PRAGMA foreign_keys = ON");
    return { sqlite, db: createSelfHostedStorageAdapter(sqlite, directory).db };
  };
  const first = open();
  const files = globSync("migrations/*.sql").sort();
  for (const file of files.filter((file) => file < "migrations/0100"))
    first.sqlite.exec(readFileSync(file, "utf8"));
  const memos = await Promise.all(tables.map((table, index) => seedLegacyMemo(first.db, table, `fixture_${index}`)));
  first.sqlite.close();
  const upgraded = open();
  for (const file of files.filter((file) => file >= "migrations/0100"))
    upgraded.sqlite.exec(readFileSync(file, "utf8"));
  return {
    ...upgraded,
    memos,
    open,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("interrupted migration resumes from committed rows and preserves v1 and v2 documents", async () => {
  const installation = await seededInstallation();
  let connection = installation;
  try {
    const migration = new SharedTableMigration(connection.db);
    await migration.start();
    let progress = await migration.advance();
    for (let calls = 0; progress.rowsCopied === 0 && calls < 30; calls++)
      progress = await migration.advance();
    expect(progress.rowsCopied).toBeGreaterThan(0);
    expect(progress.phase).toBe("copying");
    const before = await getMemoDetail(
      connection.db,
      workspace,
      installation.memos[0].id,
    );
    expect(before.contentMarkdown).toBe(installation.memos[0].contentMarkdown);
    connection.sqlite.close();
    connection = installation.open();
    const resumed = new SharedTableMigration(connection.db);
    expect(await resumed.status()).toEqual(progress);
    for (let calls = 0; progress.phase !== "ready" && calls < 30; calls++)
      progress = await resumed.advance();
    expect(progress).toMatchObject({
      phase: "ready",
      tablesCopied: 2,
      rowsCopied: 119,
    });
    expect(await resumed.advance()).toEqual(progress);
    const store = new SharedTableStore(connection.db);
    for (const memo of installation.memos) {
      const snapshot = await store.snapshot(workspace, memo.id);
      expect(snapshot).toEqual({
        ...parseTableDocument(memo.contentMarkdown),
        cellEncoding: "nullable-v1",
      });
      expect(
        (await getMemoDetail(connection.db, workspace, memo.id))
          .contentMarkdown,
      ).toBe(memo.contentMarkdown);
    }
  } finally {
    connection.sqlite.close();
    installation.cleanup();
  }
});

test("a lost mutation response can be replayed after a later write; deltas retain deletions", async () => {
  const installation = await seededInstallation();
  try {
    const migration = new SharedTableMigration(installation.db);
    let status = await migration.start();
    while (status.phase === "copying") status = await migration.advance();
    const store = new SharedTableStore(installation.db);
    const id = installation.memos[0].id;
    const edit = {
      mutationId: "edit-one",
      expectedRevision: 1,
      puts: [{ id: "row_117", cells: { name: "Edited once", files: [] } }],
    };
    const [first, duplicate] = await Promise.all([
      store.apply(workspace, id, edit),
      store.apply(workspace, id, edit),
    ]);
    expect(duplicate).toEqual(first);
    expect(first.revision).toBe(2);
    await store.apply(workspace, id, {
      mutationId: "remove-one",
      expectedRevision: 2,
      deletes: ["row_116"],
    });
    expect(await store.apply(workspace, id, edit)).toEqual(first);
    await expect(
      store.apply(workspace, id, { ...edit, deletes: ["row_115"] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.apply(workspace, id, { ...edit, mutationId: "offline-draft" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.changes(workspace, id, { since: 1 })).toMatchObject({
      revision: 3,
      changes: [
        {
          revision: 2,
          id: "row_117",
          cells: { name: "Edited once", files: [] },
        },
        { revision: 3, id: "row_116", deleted: true },
      ],
      next: null,
    });
    expect((await store.snapshot(workspace, id, 1)).records).toEqual(records);
  } finally {
    installation.sqlite.close();
    installation.cleanup();
  }
});

test("field add, type change and removal preserve old values in history", async () => {
  const installation = await seededInstallation();
  try {
    const migration = new SharedTableMigration(installation.db);
    let status = await migration.start();
    while (status.phase === "copying") status = await migration.advance();
    const store = new SharedTableStore(installation.db);
    const id = installation.memos[1].id;
    const { records: current, ...header } = await store.snapshot(workspace, id);
    await store.apply(workspace, id, {
      expectedRevision: 1,
      header: {
        ...header,
        fields: [...fields, { id: "count", name: "Count", type: "text" }],
        records: [],
      },
      puts: [{ ...current[0], cells: { ...current[0].cells, count: "42" } }],
    });
    const { records: added, ...nextHeader } = await store.snapshot(
      workspace,
      id,
    );
    expect(added.map((row) => row.cells.count)).toEqual(["42", ""]);
    await store.apply(workspace, id, {
      expectedRevision: 2,
      header: {
        ...nextHeader,
        fields: [fields[0], { id: "count", name: "Count", type: "number" }],
        records: [],
      },
    });
    const converted = await store.snapshot(workspace, id);
    expect(converted.records.map((row) => row.cells)).toEqual([
      { name: "Task 0", count: 42 },
      { name: "Task 1", count: null },
    ]);
    await store.restore(workspace, id, 1, 3);
    expect((await store.snapshot(workspace, id)).records).toEqual(current);
    expect((await store.snapshot(workspace, id, 2)).records).toEqual(added);
  } finally {
    installation.sqlite.close();
    installation.cleanup();
  }
});

test("D1 applies the schema and resumes guarded batches with saved-view indexes", async () => {
  const { createRequire } = await import("node:module");
  const requireWrangler = createRequire(
    new URL("../../../packages/wrangler/package.json", import.meta.url),
  );
  const wrangler = requireWrangler.resolve("edgeever-wrangler-cli");
  const { unstable_splitSqlQuery } = await import(wrangler);
  const { Miniflare } = createRequire(wrangler)("miniflare");
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    compatibilityDate: "2026-07-14",
    d1Databases: { DB: "edgeever-table-storage-test" },
  });
  try {
    const db = await miniflare.getD1Database("DB");
    const files = globSync("migrations/*.sql").sort();
    const apply = (file) =>
      db.batch(
        unstable_splitSqlQuery(readFileSync(file, "utf8")).map((sql) =>
          db.prepare(sql),
        ),
      );
    for (const file of files.filter((name) => name < "migrations/0100"))
      await apply(file);
    const table = {
      ...tables[1],
      records,
      views: [
        {
          id: "by_name",
          name: "By name",
          match: "all",
          filters: [],
          sorts: [{ fieldId: "name", direction: "asc" }],
        },
      ],
    };
    const memo = await seedLegacyMemo(db, table, "d1_fixture");
    for (const file of files.filter((name) => name >= "migrations/0100"))
      await apply(file);
    const migration = new SharedTableMigration(db);
    await migration.start();
    await Promise.all([migration.advance(), migration.advance()]);
    const resumed = new SharedTableMigration(db);
    let status = await resumed.status();
    while (status.phase === "copying") status = await resumed.advance();
    expect(status).toMatchObject({
      phase: "ready",
      tablesCopied: 1,
      rowsCopied: 117,
    });
    const store = new SharedTableStore(db);
    const first = await store.query(workspace, memo.id, {
      view: table.views[0],
      includeTotal: true,
    });
    expect(first.sourceRowCount).toBe(117);
    expect(first.matchedRowCount).toBe(117);
    expect(first.records[0].id).toBe("row_117");
    const second = await store.query(workspace, memo.id, {
      view: table.views[0],
      cursor: first.next,
    });
    expect(second.records).toHaveLength(50);
    expect((await store.snapshot(workspace, memo.id)).records).toEqual(records);
  } finally {
    await miniflare.dispose();
  }
}, 30_000);

test("reading a full 2,000-record current snapshot fits the D1 free invocation query budget", async () => {
  const installation = await seededInstallation();
  try {
    const wide = Array.from({ length: 2000 }, (_, index) => ({
      id: `wide_${index}`,
      cells: { name: `Record ${index}`, files: [] },
    }));
    const memo = await createMemoRecord(
      installation.db,
      workspace,
      {
        notebookId: "nb_inbox",
        contentMarkdown: serializeTableDocument({
          ...tables[0],
          records: wide,
        }),
      },
      actor,
      "test",
    );
    const migration = new SharedTableMigration(installation.db);
    let status = await migration.start();
    while (status.phase === "copying") status = await migration.advance();
    let reads = 0;
    const budgeted = {
      prepare: (sql) => {
        expect(sql).not.toContain("ee_table_versions");
        if (++reads > 50)
          throw new Error("D1 free invocation query budget exhausted");
        return installation.db.prepare(sql);
      },
      batch: (statements) => installation.db.batch(statements),
    };
    expect(
      (await new SharedTableStore(budgeted).snapshot(workspace, memo.id))
        .records,
    ).toEqual(wide);
  } finally {
    installation.sqlite.close();
    installation.cleanup();
  }
});

test("rolling back restores shared changes to legacy bodies and releases the maintenance lock", async () => {
  const installation = await seededInstallation();
  try {
    const migration = new SharedTableMigration(installation.db);
    let status = await migration.start();
    while (status.phase === "copying") status = await migration.advance();
    const id = installation.memos[0].id;
    await expect(
      createMemoRecord(
        installation.db,
        workspace,
        {
          notebookId: "nb_inbox",
          contentMarkdown: serializeTableDocument(tables[0]),
        },
        actor,
        "test",
      ),
    ).rejects.toThrow("table_migration_in_progress");
    const store = new SharedTableStore(installation.db);
    await store.apply(workspace, id, {
      expectedRevision: 1,
      deletes: ["row_116"],
      puts: [
        {
          id: "row_117",
          cells: { ...records[0].cells, name: "New shared write" },
        },
      ],
    });
    status = await migration.beginRollback();
    while (status.phase === "rolling_back") status = await migration.advance();
    expect(status.phase).toBe("legacy");
    const legacy = await getMemoDetail(installation.db, workspace, id);
    const document = parseTableDocument(legacy.contentMarkdown);
    expect(document.records[0]).toEqual({
      ...records[0],
      cells: { ...records[0].cells, name: "New shared write" },
    });
    expect(document.records).toHaveLength(116);
    expect(document.records.some((record) => record.id === "row_116")).toBe(
      false,
    );
    expect(
      (
        await getMemoDetail(
          installation.db,
          workspace,
          installation.memos[1].id,
        )
      ).contentMarkdown,
    ).toBe(installation.memos[1].contentMarkdown);
    await expect(store.snapshot(workspace, id)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await createMemoRecord(
        installation.db,
        workspace,
        {
          notebookId: "nb_inbox",
          contentMarkdown: serializeTableDocument(tables[0]),
        },
        actor,
        "test",
      ),
    ).toHaveProperty("id");
  } finally {
    installation.sqlite.close();
    installation.cleanup();
  }
});


test("ordinary memo saves after cutover persist only changed shared records", async () => {
  const installation = await seededInstallation();
  const { db, sqlite, memos } = installation;
  try {
    const migration = new SharedTableMigration(db);
    let status = await migration.start();
    while (status.phase === "copying") status = await migration.advance();
    expect((await migration.activate()).phase).toBe("active");
    const memo = memos[0];
    const document = parseTableDocument(memo.contentMarkdown);
    document.records[1].cells.name = "Updated through ordinary memo save";
    const saved = await updateMemoRecord(db, workspace, memo.id, {
      expectedRevision: memo.revision,
      contentMarkdown: serializeTableDocument(document),
    }, actor, "test");
    expect(parseTableDocument(saved.memo.contentMarkdown).records).toEqual(document.records);
    expect(parseTableDocument((await getMemoDetail(db, workspace, memo.id)).contentMarkdown).records).toEqual(document.records);
    expect((await new SharedTableStore(db).changes(workspace, memo.id, { since: 1 })).changes)
      .toMatchObject([{ id: document.records[1].id, deleted: false, cells: document.records[1].cells }]);
    const stored = sqlite.query("SELECT content_markdown, shared_table_revision FROM memo_contents WHERE memo_id = ?").get(memo.id);
    expect(stored.shared_table_revision).toBe(2);
    expect(stored.content_markdown).not.toContain("Updated through ordinary memo save");
  } finally {
    sqlite.close();
    installation.cleanup();
  }
});

test("new tables and memo history use shared revisions after activation", async () => {
  const installation = await seededInstallation();
  try {
    const { db, sqlite } = installation;
    const migration = new SharedTableMigration(db);
    let status = await migration.start();
    while (status.phase === "copying") status = await migration.advance();
    await migration.activate();
    const created = await createMemoRecord(db, workspace, { notebookId: "nb_inbox", contentMarkdown: serializeTableDocument(tables[1]) }, actor, "test");
    expect(sqlite.query("SELECT shared_table_revision FROM memo_contents WHERE memo_id = ?").get(created.id).shared_table_revision).toBe(1);
    const changed = parseTableDocument(created.contentMarkdown);
    changed.records[0].cells.name = "Current after save";
    await updateMemoRecord(db, workspace, created.id, {
      expectedRevision: created.revision, contentMarkdown: serializeTableDocument(changed),
    }, actor, "test");
    const revision = sqlite.query("SELECT id, shared_table_revision FROM memo_revisions WHERE memo_id = ?").get(created.id);
    expect(revision.shared_table_revision).toBe(1);
    const histories = await listMemoRevisions(db, workspace, created.id, 10, getMemoDetail, false);
    expect(parseTableDocument(histories[0].contentMarkdown).records).toEqual(tables[1].records);
    const restored = await restoreMemoRevision(db, workspace, created.id, revision.id, actor, "test", {
      getMemoDetail, getMemoDetailRow, updateMemoRecord,
    });
    expect(parseTableDocument(restored.contentMarkdown).records).toEqual(tables[1].records);
    expect((await new SharedTableStore(db).changes(workspace, created.id, { since: 2 })).changes[0].cells.name).toBe(tables[1].records[0].cells.name);
  } finally {
    installation.sqlite.close();
    installation.cleanup();
  }
});

test("an active table form appends one record without reading the current table snapshot", async () => {
  const installation = await seededInstallation();
  try {
    const { db, memos } = installation;
    const migration = new SharedTableMigration(db);
    let status = await migration.start();
    while (status.phase === "copying") status = await migration.advance();
    await migration.activate();
    const id = memos[0].id;
    const queries = [];
    const tracked = { prepare: (sql) => { queries.push(sql); return db.prepare(sql); }, batch: (statements) => db.batch(statements) };
    await appendTableFormSubmission(tracked, {
      memo_id: id, workspace_id: workspace, created_by: actor.actorId,
      fields_json: JSON.stringify([{ fieldId: "name", required: true }]),
    }, { name: "Published form response" }, new Map());
    expect(queries.some((query) => /ORDER BY (?:p\.)?position|c\.content_json/.test(query))).toBe(false);
    const delta = await new SharedTableStore(db).changes(workspace, id, { since: 1 });
    expect(delta.changes).toMatchObject([{ deleted: false, cells: { name: "Published form response", files: [] } }]);
    const current = parseTableDocument((await getMemoDetail(db, workspace, id)).contentMarkdown);
    expect(current.records).toHaveLength(records.length + 1);
    expect(current.records.at(-1).id).toBe(delta.changes[0].id);
  } finally {
    installation.sqlite.close();
    installation.cleanup();
  }
});

test("legacy sync and the default backup entry read current shared records and revision snapshots", async () => {
  const installation = await seededInstallation();
  try {
    const { db } = installation;
    const migration = new SharedTableMigration(db);
    let status = await migration.start();
    while (status.phase === "copying") status = await migration.advance();
    await migration.activate();
    const created = await createMemoRecord(db, workspace, { notebookId: "nb_inbox", contentMarkdown: serializeTableDocument(tables[1]) }, actor, "test");
    const changed = parseTableDocument(created.contentMarkdown);
    changed.records[0].cells.name = "Visible in sync and backup";
    await updateMemoRecord(db, workspace, created.id, { expectedRevision: created.revision, contentMarkdown: serializeTableDocument(changed) }, actor, "test");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("auth", { kind: "user", actorId: actor.actorId, workspaceId: workspace, role: "owner" }); await next(); });
    const common = { clampNumber: (n, min, max) => Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min, mapMemoDetail };
    registerSyncRoutes(app, common);
    registerSharedTableRoutes(app);
    registerBackupRoutes(app, { ...common, getMemoDetail });
    const get = async (url) => {
      const response = await app.request(url, undefined, { storage: { db } });
      expect(response.status).toBe(200);
      return response.json();
    };
    const deltaResponse = await app.request(`/api/v1/memos/${created.id}/table/changes`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ since: 1 }),
    }, { storage: { db } });
    expect(deltaResponse.status).toBe(200);
    expect((await deltaResponse.json()).changes).toMatchObject([{ id: changed.records[0].id, cells: changed.records[0].cells }]);
    const snapshot = await get("/api/v1/sync/bootstrap?limit=20");
    expect(parseTableDocument(snapshot.memos.find((memo) => memo.id === created.id).contentMarkdown).records).toEqual(changed.records);
    const sync = await get("/api/v1/sync/changes?cursor=0&limit=50");
    expect(parseTableDocument(sync.changes.find((change) => change.entityId === created.id).memo.contentMarkdown).records).toEqual(changed.records);
    const { identity, backupRevision } = await get("/api/v1/backups/state");
    const backup = await get(`/api/v1/backups/data?kind=memos&limit=25&identity=${encodeURIComponent(identity)}&revision=${backupRevision}`);
    expect(parseTableDocument(backup.memos.find((memo) => memo.id === created.id).contentMarkdown).records).toEqual(changed.records);
    expect(parseTableDocument(backup.revisions.find((revision) => revision.memoId === created.id).contentMarkdown).records).toEqual(tables[1].records);
    const exportedMemo = backup.memos.find((memo) => memo.id === created.id);
    const exportedRevisions = backup.revisions.filter((revision) => revision.memoId === created.id);
    const newRecords = { ...changed, records: changed.records.slice(0, 1) };
    const beforeRestore = await getMemoDetail(db, workspace, created.id);
    await updateMemoRecord(db, workspace, created.id, { expectedRevision: beforeRestore.revision, contentMarkdown: serializeTableDocument(newRecords) }, actor, "test");
    await restoreJsonMemos(db, workspace, [{ memo: exportedMemo, revisions: exportedRevisions }]);
    expect(parseTableDocument((await getMemoDetail(db, workspace, created.id)).contentMarkdown).records).toEqual(changed.records);
    expect(parseTableDocument((await listMemoRevisions(db, workspace, created.id, 10, getMemoDetail))[0].contentMarkdown).records).toEqual(tables[1].records);
  } finally {
    installation.sqlite.close();
    installation.cleanup();
  }
});

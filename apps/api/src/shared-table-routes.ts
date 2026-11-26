import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext, AppEnv } from "./api-context";
import { notFound } from "./http-errors";
import { getSharedMemoWriteState } from "./memo-service";
import { getWorkspaceId, requireScopes } from "./request-auth";
import { SharedTableStore } from "./shared-table-store";
import { assertNotebookAccess, resolveRequestNotebookAccess } from "./token-notebook-access";

const revision = z.number().int().positive();
const changeSchema = z.object({
  since: revision,
  through: revision.optional(),
  after: z.object({ revision, recordId: z.string().min(1).max(80) }).optional(),
});
const tableQuerySchema = z.object({
  view: z.object({
    match: z.enum(["all", "any"]),
    filters: z.array(z.unknown()),
    sorts: z.array(z.unknown()),
  }),
  revision: revision.optional(),
  cursor: z.string().optional(),
  week: z.tuple([z.string(), z.string()]).optional(),
  includeTotal: z.boolean().optional(),
});

export const registerSharedTableRoutes = (app: Hono<AppEnv>) => {
  const authorize = async (c: AppContext, id: string) => {
    const denied = requireScopes(c, "read:memos");
    if (denied) return denied;
    const current = await getSharedMemoWriteState(c.env.storage.db, getWorkspaceId(c), id);
    if (!current) return notFound(c, "Shared table not found");
    assertNotebookAccess(await resolveRequestNotebookAccess(c), "read", current.notebook_id, "read this table");
    return null;
  };

  app.post("/api/v1/memos/:id/table/query", zValidator("json", tableQuerySchema), async (c) => {
    const id = c.req.param("id");
    const denied = await authorize(c, id);
    if (denied) return denied;
    const store = new SharedTableStore(c.env.storage.db);
    return c.json(await store.query(getWorkspaceId(c), id, c.req.valid("json")));
  });

  app.post("/api/v1/memos/:id/table/changes", zValidator("json", changeSchema), async (c) => {
    const id = c.req.param("id");
    const denied = await authorize(c, id);
    if (denied) return denied;
    const store = new SharedTableStore(c.env.storage.db);
    return c.json(await store.changes(getWorkspaceId(c), id, c.req.valid("json")));
  });
};

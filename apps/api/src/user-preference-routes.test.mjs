import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { registerUserPreferenceRoutes } from "./user-preference-routes.ts";

class SqliteD1PreparedStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1PreparedStatement(this.db, this.sql, bindings);
  }

  async all() {
    return { results: this.db.query(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async run() {
    this.db.query(this.sql).run(...this.bindings);
    return { success: true, meta: {} };
  }
}

class SqliteD1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements) {
    return this.db.transaction(() => statements.map((statement) =>
      this.db.query(statement.sql).run(...statement.bindings)))();
  }
}

const createApp = (auth) => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  registerUserPreferenceRoutes(app);
  return { sqlite, app, environment: { storage: { db: new SqliteD1Database(sqlite), resources: {} } } };
};

const user = (actorId) => ({ kind: "user", actorType: "user", actorId, username: "owner", displayName: null, scopes: [], workspaceId: "ws_default", role: "owner" });

const patch = (app, environment, body) => app.request("/api/v1/me/preferences", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}, environment);

describe("user preference routes", () => {
  test("returns defaults before anything is stored", async () => {
    const { sqlite, app, environment } = createApp(user("usr_a"));
    const response = await app.request("/api/v1/me/preferences", {}, environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preferences: { showDescendantNotes: true } });
    sqlite.close();
  });

  test("stores preferences per user and overwrites on repeat", async () => {
    const { sqlite, app, environment } = createApp(user("usr_a"));
    expect(await (await patch(app, environment, { showDescendantNotes: false })).json())
      .toEqual({ preferences: { showDescendantNotes: false } });
    expect(await (await patch(app, environment, { showDescendantNotes: true })).json())
      .toEqual({ preferences: { showDescendantNotes: true } });
    expect(sqlite.query("SELECT user_id, key, value_json FROM user_preferences").all())
      .toEqual([{ user_id: "usr_a", key: "showDescendantNotes", value_json: "true" }]);
    sqlite.close();
  });

  test("keeps users isolated", async () => {
    const { sqlite, app, environment } = createApp(user("usr_a"));
    await patch(app, environment, { showDescendantNotes: false });
    sqlite.query("INSERT INTO user_preferences (user_id, key, value_json, updated_at) VALUES ('usr_b', 'showDescendantNotes', 'true', '')").run();
    expect(await (await app.request("/api/v1/me/preferences", {}, environment)).json())
      .toEqual({ preferences: { showDescendantNotes: false } });
    sqlite.close();
  });

  test("stores the owner under the local id when authentication is disabled", async () => {
    const { sqlite, app, environment } = createApp(user(null));
    await patch(app, environment, { showDescendantNotes: false });
    expect(sqlite.query("SELECT user_id FROM user_preferences").get().user_id).toBe("local");
    sqlite.close();
  });

  test("falls back to defaults for corrupt stored values", async () => {
    const { sqlite, app, environment } = createApp(user("usr_a"));
    sqlite.query("INSERT INTO user_preferences (user_id, key, value_json, updated_at) VALUES ('usr_a', 'showDescendantNotes', '{bad', '')").run();
    expect(await (await app.request("/api/v1/me/preferences", {}, environment)).json())
      .toEqual({ preferences: { showDescendantNotes: true } });
    sqlite.close();
  });

  test("rejects unknown keys and agent tokens", async () => {
    const { sqlite, app, environment } = createApp(user("usr_a"));
    expect((await patch(app, environment, { theme: "dark" })).status).toBe(400);
    sqlite.close();

    const agent = createApp({ ...user("tok_1"), kind: "agent", actorType: "agent", scopes: ["read:memos"] });
    expect((await agent.app.request("/api/v1/me/preferences", {}, agent.environment)).status).toBe(403);
    expect((await patch(agent.app, agent.environment, { showDescendantNotes: false })).status).toBe(403);
    agent.sqlite.close();
  });
});

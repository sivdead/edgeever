import { resolveUserPreferences, USER_PREFERENCE_KEYS, UserPreferencesUpdateSchema, type UserPreferences, type UserPreferencesUpdate } from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { AppContext, AppEnv, Bindings } from "./api-context";
import { isoNow } from "./entity-utils";
import { requireUser } from "./request-auth";

// Matches the user id /api/v1/auth/session reports when authentication is disabled.
const UNAUTHENTICATED_OWNER_ID = "local";

type PreferenceRow = { key: string; value_json: string };

const getPreferenceUserId = (c: AppContext) => c.get("auth").actorId ?? UNAUTHENTICATED_OWNER_ID;

export const readUserPreferences = async (db: Bindings["storage"]["db"], userId: string): Promise<UserPreferences> => {
  const { results } = await db.prepare(
    `SELECT key, value_json FROM user_preferences WHERE user_id = ?`
  ).bind(userId).all<PreferenceRow>();
  const stored: Record<string, unknown> = {};
  for (const row of results ?? []) {
    try {
      stored[row.key] = JSON.parse(row.value_json);
    } catch {
      // A corrupt value falls back to its default.
    }
  }
  return resolveUserPreferences(stored);
};

export const writeUserPreferences = async (db: Bindings["storage"]["db"], userId: string, update: UserPreferencesUpdate) => {
  const now = isoNow();
  const statements = USER_PREFERENCE_KEYS
    .filter((key) => update[key] !== undefined)
    .map((key) => db.prepare(
      `INSERT INTO user_preferences (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).bind(userId, key, JSON.stringify(update[key]), now));
  if (statements.length > 0) await db.batch(statements);
};

export const registerUserPreferenceRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/v1/me/preferences", async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    return c.json({ preferences: await readUserPreferences(c.env.storage.db, getPreferenceUserId(c)) });
  });

  app.patch("/api/v1/me/preferences", zValidator("json", UserPreferencesUpdateSchema), async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const userId = getPreferenceUserId(c);
    await writeUserPreferences(c.env.storage.db, userId, c.req.valid("json"));
    return c.json({ preferences: await readUserPreferences(c.env.storage.db, userId) });
  });
};

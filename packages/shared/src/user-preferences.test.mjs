import { describe, expect, test } from "bun:test";
import { DEFAULT_USER_PREFERENCES, resolveUserPreferences, UserPreferencesUpdateSchema } from "./user-preferences.ts";

describe("resolveUserPreferences", () => {
  test("defaults to showing descendant notes", () => {
    expect(resolveUserPreferences(null)).toEqual({ showDescendantNotes: true });
    expect(DEFAULT_USER_PREFERENCES.showDescendantNotes).toBe(true);
  });

  test("applies stored booleans and ignores malformed or unknown values", () => {
    expect(resolveUserPreferences({ showDescendantNotes: false })).toEqual({ showDescendantNotes: false });
    expect(resolveUserPreferences({ showDescendantNotes: "false", unknown: 1 })).toEqual({ showDescendantNotes: true });
  });
});

describe("UserPreferencesUpdateSchema", () => {
  test("accepts partial updates and rejects unknown keys", () => {
    expect(UserPreferencesUpdateSchema.safeParse({ showDescendantNotes: false }).success).toBe(true);
    expect(UserPreferencesUpdateSchema.safeParse({}).success).toBe(true);
    expect(UserPreferencesUpdateSchema.safeParse({ theme: "dark" }).success).toBe(false);
    expect(UserPreferencesUpdateSchema.safeParse({ showDescendantNotes: "no" }).success).toBe(false);
  });
});

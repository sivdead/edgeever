import { z } from "zod";

// Account-level preferences stored server-side and shared by every client.
// Clients must fall back to these defaults when talking to older servers.
export const DEFAULT_USER_PREFERENCES = Object.freeze({
  showDescendantNotes: true,
});

export type UserPreferences = {
  showDescendantNotes: boolean;
};

export const UserPreferencesUpdateSchema = z.object({
  showDescendantNotes: z.boolean().optional(),
}).strict();

export type UserPreferencesUpdate = z.infer<typeof UserPreferencesUpdateSchema>;

export const USER_PREFERENCE_KEYS = Object.freeze(Object.keys(DEFAULT_USER_PREFERENCES) as (keyof UserPreferences)[]);

// Merges stored values over the defaults, ignoring unknown keys and values of
// the wrong type so a bad row never breaks the notebook view.
export const resolveUserPreferences = (stored: Partial<Record<string, unknown>> | null | undefined): UserPreferences => {
  const preferences: UserPreferences = { ...DEFAULT_USER_PREFERENCES };
  if (typeof stored?.showDescendantNotes === "boolean") {
    preferences.showDescendantNotes = stored.showDescendantNotes;
  }
  return preferences;
};

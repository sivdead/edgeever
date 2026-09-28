import { DEFAULT_USER_PREFERENCES, resolveUserPreferences, type UserPreferences } from "@edgeever/shared";

// The server owns account preferences; this per-user copy only keeps the last
// known value available offline and before the first request finishes.
const storageKey = (userId: string) => `edgeever.userPreferences.${userId}`;

export const readCachedUserPreferences = (userId: string | null | undefined): UserPreferences => {
  if (!userId || typeof window === "undefined") return { ...DEFAULT_USER_PREFERENCES };
  try {
    const stored = window.localStorage?.getItem(storageKey(userId));
    return resolveUserPreferences(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_USER_PREFERENCES };
  }
};

export const writeCachedUserPreferences = (userId: string | null | undefined, preferences: UserPreferences) => {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(storageKey(userId), JSON.stringify(preferences));
  } catch {
    // Blocked storage only loses the offline copy.
  }
};

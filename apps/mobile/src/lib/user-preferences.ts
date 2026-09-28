import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_USER_PREFERENCES, resolveUserPreferences, type UserPreferences } from "@edgeever/shared";

// The server owns account preferences; this per-account copy only keeps the
// last known value available offline and while the app starts.
const storageKey = (dataScope: string) => `edgeever.mobile.userPreferences.${dataScope}`;

export const readCachedMobileUserPreferences = async (dataScope: string): Promise<UserPreferences> => {
  try {
    const stored = await AsyncStorage.getItem(storageKey(dataScope));
    return resolveUserPreferences(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_USER_PREFERENCES };
  }
};

export const writeCachedMobileUserPreferences = async (dataScope: string, preferences: UserPreferences) => {
  try {
    await AsyncStorage.setItem(storageKey(dataScope), JSON.stringify(preferences));
  } catch {
    // Losing the offline copy only means the next launch waits for the server.
  }
};

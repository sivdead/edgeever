import { beforeEach, expect, mock, test } from "bun:test";

const storage = new Map<string, string>();

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
  },
}));

const { readCachedMobileUserPreferences, writeCachedMobileUserPreferences } = await import("./user-preferences");

beforeEach(() => storage.clear());

test("defaults to showing descendant notes when nothing is cached", async () => {
  expect(await readCachedMobileUserPreferences("https://a|usr_a")).toEqual({ showDescendantNotes: true });
});

test("keeps each account's copy separate", async () => {
  await writeCachedMobileUserPreferences("https://a|usr_a", { showDescendantNotes: false });
  expect(await readCachedMobileUserPreferences("https://a|usr_a")).toEqual({ showDescendantNotes: false });
  expect(await readCachedMobileUserPreferences("https://a|usr_b")).toEqual({ showDescendantNotes: true });
});

test("ignores a corrupt cached value", async () => {
  storage.set("edgeever.mobile.userPreferences.https://a|usr_a", "{bad");
  expect(await readCachedMobileUserPreferences("https://a|usr_a")).toEqual({ showDescendantNotes: true });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readCachedUserPreferences, writeCachedUserPreferences } from "./user-preferences.ts";

describe("cached user preferences", () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.window = {
      localStorage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, value),
      },
    };
  });
  afterEach(() => {
    delete globalThis.window;
  });

  test("defaults to showing descendant notes when nothing is cached", () => {
    expect(readCachedUserPreferences("usr_a")).toEqual({ showDescendantNotes: true });
    expect(readCachedUserPreferences(null)).toEqual({ showDescendantNotes: true });
  });

  test("keeps each account's copy separate", () => {
    writeCachedUserPreferences("usr_a", { showDescendantNotes: false });
    expect(readCachedUserPreferences("usr_a")).toEqual({ showDescendantNotes: false });
    expect(readCachedUserPreferences("usr_b")).toEqual({ showDescendantNotes: true });
  });

  test("ignores a corrupt cached value", () => {
    store.set("edgeever.userPreferences.usr_a", "{bad");
    expect(readCachedUserPreferences("usr_a")).toEqual({ showDescendantNotes: true });
  });
});

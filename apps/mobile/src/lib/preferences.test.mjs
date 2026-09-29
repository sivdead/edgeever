import { expect, test } from "bun:test";

// Keep the native module mock out of the other mobile tests' module cache.
test("descendant preference defaults safely when native storage fails", () => {
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    let stored = null;
    let rejects = false;
    mock.module("@react-native-async-storage/async-storage", () => ({ default: {
      getItem: async () => { if (rejects) throw new Error("storage unavailable"); return stored; },
      setItem: async (_key, value) => { stored = value; },
    } }));
    const { readMobileShowDescendantNotes, writeMobileShowDescendantNotes } =
      await import(${JSON.stringify(new URL("./preferences.ts", import.meta.url).href)});
    assert.equal(await readMobileShowDescendantNotes(), true);
    await writeMobileShowDescendantNotes(false);
    assert.equal(await readMobileShowDescendantNotes(), false);
    await writeMobileShowDescendantNotes(true);
    assert.equal(await readMobileShowDescendantNotes(), true);
    rejects = true;
    assert.equal(await readMobileShowDescendantNotes(), true);
  `], { stdout: "pipe", stderr: "pipe" });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
});

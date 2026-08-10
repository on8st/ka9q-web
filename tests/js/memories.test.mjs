import { test } from "node:test";
import assert from "node:assert/strict";

// Node has no global localStorage by default (real browsers always do) -
// a minimal in-memory shim, test-only, not a change to what ships.
globalThis.localStorage ??= (() => {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    clear: () => { store = {}; },
  };
})();

const { loadMemories, addMemory, deleteMemory, defaultLabel } = await import("../../html/instrument/memories.js");

test("loadMemories returns [] when nothing is stored yet", () => {
  localStorage.clear();
  assert.deepEqual(loadMemories(), []);
});

test("addMemory persists and loadMemories reads it back", () => {
  localStorage.clear();
  const after = addMemory([], 145_500_000, "2m calling");
  assert.deepEqual(after, [{ freqHz: 145_500_000, label: "2m calling" }]);
  assert.deepEqual(loadMemories(), after);
});

test("addMemory without a label defaults to a formatted MHz label", () => {
  const after = addMemory([], 14_250_000);
  assert.equal(after[0].label, defaultLabel(14_250_000));
  assert.equal(after[0].label, "14.250 MHz");
});

test("deleteMemory removes exactly the indexed entry", () => {
  localStorage.clear();
  let mem = addMemory([], 1_000_000, "a");
  mem = addMemory(mem, 2_000_000, "b");
  mem = addMemory(mem, 3_000_000, "c");
  const after = deleteMemory(mem, 1);
  assert.deepEqual(after.map((m) => m.label), ["a", "c"]);
  assert.deepEqual(loadMemories().map((m) => m.label), ["a", "c"]);
});

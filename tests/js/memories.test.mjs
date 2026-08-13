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

const { loadMemories, addMemory, deleteMemory, replaceMemories, defaultLabel, exportMemoriesJson, importMemoriesJson } = await import("../../html/memories.js");

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

test("exportMemoriesJson/importMemoriesJson round-trip this UI's own format exactly", () => {
  const memories = [{ freqHz: 14_074_000, label: "FT8" }, { freqHz: 145_500_000, label: "2m calling" }];
  const json = exportMemoriesJson(memories);
  assert.deepEqual(importMemoriesJson(json), memories);
});

test("importMemoriesJson accepts a genuine stock 50-slot export, dropping empty slots and translating fields", () => {
  const stockExport = [
    { freq: "14195000", desc: "20m SSB", mode: "usb" },
    { freq: "", desc: "", mode: "" }, // empty slot, ported exactly - stock always has 50, most empty
    { freq: "7074000", desc: "", mode: "usb" }, // no desc - should fall back to defaultLabel
  ];
  const result = importMemoriesJson(JSON.stringify(stockExport));
  assert.deepEqual(result, [
    { freqHz: 14_195_000, label: "20m SSB" },
    { freqHz: 7_074_000, label: defaultLabel(7_074_000) },
  ]);
});

test("importMemoriesJson returns null for invalid/unrecognised JSON", () => {
  assert.equal(importMemoriesJson("not json"), null);
  assert.equal(importMemoriesJson("{}"), null); // not an array
  assert.equal(importMemoriesJson(JSON.stringify([{ unrelated: true }])), null);
});

test("importMemoriesJson on an empty array returns an empty list, not null", () => {
  assert.deepEqual(importMemoriesJson("[]"), []);
});

test("replaceMemories persists the given list wholesale (used after a successful import)", () => {
  localStorage.clear();
  addMemory([], 1_000_000, "stale");
  const fresh = [{ freqHz: 14_074_000, label: "FT8" }];
  const result = replaceMemories(fresh);
  assert.deepEqual(result, fresh);
  assert.deepEqual(loadMemories(), fresh);
});

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage ??= (() => {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    clear: () => { store = {}; },
  };
})();

const { loadNotes, saveNotes } = await import("../../html/notes.js");
const { spectrumToCsv } = await import("../../html/spectrum-export.js");

test("loadNotes returns empty string when nothing saved yet", () => {
  localStorage.clear();
  assert.equal(loadNotes(), "");
});

test("saveNotes persists and loadNotes reads it back", () => {
  localStorage.clear();
  saveNotes("2m band is quiet today");
  assert.equal(loadNotes(), "2m band is quiet today");
});

test("spectrumToCsv produces one header row plus one row per bin, hz spanning the full width", () => {
  const spectrum = { binsDb: new Float32Array([-90, -80, -70]), binWidthHz: 1000, binCount: 3 };
  const csv = spectrumToCsv(spectrum, 145_500_000);
  const rows = csv.split("\n");
  assert.equal(rows.length, 4); // header + 3 bins
  assert.equal(rows[0], "hz,db");
  const startHz = 145_500_000 - (1000 * 3) / 2;
  assert.equal(rows[1], `${Math.round(startHz)},-90.00`);
  assert.equal(rows[3], `${Math.round(startHz + 2000)},-70.00`);
});

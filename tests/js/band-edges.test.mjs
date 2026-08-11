import { test } from "node:test";
import assert from "node:assert/strict";
import { HAM_BAND_EDGES, bandEdgesInSpan } from "../../html/instrument/band-edges.js";

test("HAM_BAND_EDGES has 22 bands, all with lowHz < highHz", () => {
  assert.equal(HAM_BAND_EDGES.length, 22);
  for (const b of HAM_BAND_EDGES) assert.ok(b.lowHz < b.highHz, `${b.label} has lowHz >= highHz`);
});

test("bandEdgesInSpan returns only bands overlapping the given span", () => {
  // 20m only (14.000-14.350 MHz), well clear of 30m/17m on either side.
  const result = bandEdgesInSpan(14_100_000, 14_200_000);
  assert.deepEqual(result.map((b) => b.label), ["20m"]);
});

test("bandEdgesInSpan includes a band that only partially overlaps the span", () => {
  const result = bandEdgesInSpan(13_900_000, 14_100_000); // spans into 20m's low edge only
  assert.deepEqual(result.map((b) => b.label), ["20m"]);
});

test("bandEdgesInSpan returns multiple bands for a wide span (e.g. the five 60m channels)", () => {
  const result = bandEdgesInSpan(5_000_000, 5_500_000);
  assert.deepEqual(result.map((b) => b.label), ["60m ch1", "60m ch2", "60m qrp", "60m ch4", "60m ch5"]);
});

test("bandEdgesInSpan returns [] for a span with no ham bands (e.g. broadcast FM)", () => {
  assert.deepEqual(bandEdgesInSpan(88_000_000, 108_000_000), []);
});

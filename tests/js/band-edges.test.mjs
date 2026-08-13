import { test } from "node:test";
import assert from "node:assert/strict";
import { HAM_BAND_EDGES, bandEdgesInSpan } from "../../html/band-edges.js";

test("HAM_BAND_EDGES has 18 bands, all with lowHz < highHz", () => {
  // Was 21 - 2026-08-13: the five US-channelized "60m ch1..ch5" entries
  // collapsed into a single Belgian "60m" segment (UBA-confirmed
  // 5351.5-5366.5kHz, net -4), and a new "4m" entry added (UBA-confirmed
  // 70.1125-70.4125MHz secondary, net +1) - 21 - 4 + 1 = 18. Before that,
  // was 22 - "125cm" (222-225MHz) removed: an IARU Region 2 (Americas)
  // allocation with no equivalent in Region 1 at all (this station is
  // ON8ST, Belgium), not just a differently-sized band like the others.
  assert.equal(HAM_BAND_EDGES.length, 18);
  for (const b of HAM_BAND_EDGES) assert.ok(b.lowHz < b.highHz, `${b.label} has lowHz >= highHz`);
});

test("2m and 70cm use IARU Region 1 edges, not Region 2", () => {
  // Reported live 2026-08-13: this table was ported from a Region 2
  // (Americas) reference and had 2m as 144-148MHz (Region 2) instead of
  // Region 1's 144-146MHz - the same class of error also affected 70cm
  // (420-450 Region 2 vs 430-440 Region 1) and 40m/80m (fixed in the
  // same change, not re-asserted individually here).
  const twoM = HAM_BAND_EDGES.find((b) => b.label === "2m");
  const seventyCm = HAM_BAND_EDGES.find((b) => b.label === "70cm");
  assert.deepEqual([twoM.lowHz, twoM.highHz], [144_000_000, 146_000_000]);
  assert.deepEqual([seventyCm.lowHz, seventyCm.highHz], [430_000_000, 440_000_000]);
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

test("bandEdgesInSpan returns the single 60m band for a wide span", () => {
  // Was 5 separate "60m ch1..ch5" labels (US channelization) before
  // 2026-08-13's switch to Belgium's single UBA-confirmed segment.
  const result = bandEdgesInSpan(5_000_000, 5_500_000);
  assert.deepEqual(result.map((b) => b.label), ["60m"]);
});

test("bandEdgesInSpan returns [] for a span with no ham bands (e.g. broadcast FM)", () => {
  assert.deepEqual(bandEdgesInSpan(88_000_000, 108_000_000), []);
});

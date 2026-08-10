import { test } from "node:test";
import assert from "node:assert/strict";
import { BAND_OPTIONS, bandsInCoverage } from "../../html/instrument/band-options.js";

test("VHF coverage (144-146MHz) surfaces only 2M from the amateur list", () => {
  const bands = bandsInCoverage("amateur", 143_872_009, 146_128_009);
  assert.deepEqual(bands.map((b) => b.label), ["2M"]);
});

test("UHF coverage (431-440MHz) surfaces only 70CM", () => {
  const bands = bandsInCoverage("amateur", 431_300_018, 440_100_018);
  assert.deepEqual(bands.map((b) => b.label), ["70CM"]);
});

test("HF coverage (0-30.456MHz) surfaces the HF amateur bands but not 2M/70CM", () => {
  const bands = bandsInCoverage("amateur", 15_000, 30_456_000);
  assert.ok(bands.some((b) => b.label === "40M"));
  assert.ok(bands.some((b) => b.label === "10M"));
  assert.ok(!bands.some((b) => b.label === "2M" || b.label === "70CM"));
});

test("a category with nothing in range returns an empty list, not an error", () => {
  assert.deepEqual(bandsInCoverage("broadcast", 431_300_018, 440_100_018), []);
});

test("unknown category returns an empty list rather than throwing", () => {
  assert.deepEqual(bandsInCoverage("nonexistent", 0, 1e9), []);
});

test("BAND_OPTIONS carries this fork's own 2m/70cm additions", () => {
  assert.ok(BAND_OPTIONS.amateur.some((b) => b.label === "2M" && b.freq === 145_500_000));
  assert.ok(BAND_OPTIONS.amateur.some((b) => b.label === "70CM" && b.freq === 433_500_000));
});

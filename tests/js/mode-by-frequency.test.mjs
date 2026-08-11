import { test } from "node:test";
import assert from "node:assert/strict";
import { modeForFrequency } from "../../html/instrument/mode-by-frequency.js";

test("modeForFrequency returns null (no override) above 30 MHz - never touches VHF/UHF", () => {
  assert.equal(modeForFrequency(145_500_000), null);
  assert.equal(modeForFrequency(30_000_000), null); // exactly the boundary
});

test("modeForFrequency picks AM for WWV/WWVH carriers", () => {
  for (const hz of [2_500_000, 5_000_000, 10_000_000, 15_000_000, 20_000_000, 25_000_000]) {
    assert.equal(modeForFrequency(hz), "am", `${hz} Hz should be AM`);
  }
});

test("modeForFrequency picks USB for CHU carriers", () => {
  assert.equal(modeForFrequency(3_330_000), "usb");
  assert.equal(modeForFrequency(7_850_000), "usb");
});

test("modeForFrequency picks the correct sideband for the classic HF ham bands", () => {
  assert.equal(modeForFrequency(1_900_000), "lsb"); // 160m
  assert.equal(modeForFrequency(3_700_000), "lsb"); // 80m
  assert.equal(modeForFrequency(7_100_000), "lsb"); // 40m
  assert.equal(modeForFrequency(10_120_000), "cwu"); // 30m
  assert.equal(modeForFrequency(14_200_000), "usb"); // 20m
  assert.equal(modeForFrequency(18_100_000), "usb"); // 17m
  assert.equal(modeForFrequency(21_200_000), "usb"); // 15m
  assert.equal(modeForFrequency(24_920_000), "usb"); // 12m
  assert.equal(modeForFrequency(28_500_000), "usb"); // 10m
});

test("modeForFrequency handles CB and its extension band", () => {
  assert.equal(modeForFrequency(27_100_000), "am"); // CB
  assert.equal(modeForFrequency(27_385_000), "lsb"); // CB extension
});

test("modeForFrequency falls back to the 10MHz-line catch-all outside any named band", () => {
  assert.equal(modeForFrequency(4_500_000), "lsb"); // below 10MHz, no band matched
  assert.equal(modeForFrequency(12_000_000), "usb"); // at/above 10MHz, no band matched
});

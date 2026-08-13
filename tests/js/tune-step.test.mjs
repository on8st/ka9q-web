import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStep, fmtStep, STEP_OPTIONS_HZ, ALT_STEP_HZ, roundToNearestKhz } from "../../html/tune-step.js";

test("applyStep adds/subtracts the step and never goes negative", () => {
  assert.equal(applyStep(145_500_000, 1000, 1), 145_501_000);
  assert.equal(applyStep(145_500_000, 1000, -1), 145_499_000);
  assert.equal(applyStep(500, 1000, -1), 0);
});

test("fmtStep formats Hz/kHz/MHz thresholds correctly", () => {
  assert.equal(fmtStep(1), "1 Hz");
  assert.equal(fmtStep(500), "500 Hz");
  assert.equal(fmtStep(1000), "1 kHz");
  assert.equal(fmtStep(9000), "9 kHz");
  assert.equal(fmtStep(1_000_000), "1 MHz");
});

test("STEP_OPTIONS_HZ matches the stock UI's own step list exactly", () => {
  assert.deepEqual(STEP_OPTIONS_HZ, [1, 10, 100, 250, 500, 1000, 5000, 9000, 10000, 100000, 1000000]);
});

test("roundToNearestKhz ('Alt' manual-entry rounding) rounds to the nearest whole kHz", () => {
  assert.equal(roundToNearestKhz(14_074_499), 14_074_000);
  assert.equal(roundToNearestKhz(14_074_500), 14_075_000);
  assert.equal(roundToNearestKhz(14_074_600), 14_075_000);
});

test("applyStep with ALT_STEP_HZ steps by exactly 10 Hz regardless of the selected step size", () => {
  assert.equal(applyStep(14_074_000, ALT_STEP_HZ, 1), 14_074_010);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { digitsForFreq, stepFreqAtDigit, MAX_HZ, NUM_DIGITS } from "../../html/freq-digits.js";

test("digitsForFreq pads and splits correctly", () => {
  assert.deepEqual(digitsForFreq(145_500_000), [1, 4, 5, 5, 0, 0, 0, 0, 0]);
  assert.deepEqual(digitsForFreq(0), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(digitsForFreq(7), [0, 0, 0, 0, 0, 0, 0, 0, 7]);
});

test("digitsForFreq clamps out-of-range instead of silently dropping leading digits", () => {
  assert.deepEqual(digitsForFreq(10 ** NUM_DIGITS + 5), digitsForFreq(MAX_HZ));
});

test("stepFreqAtDigit incrementing the ones place is +1 Hz", () => {
  assert.equal(stepFreqAtDigit(145_500_000, 0, 1), 145_500_001);
});

test("stepFreqAtDigit incrementing a middle digit carries correctly (pure arithmetic, no manual carry logic)", () => {
  // digit index 5 = the 100,000s place. 145,500,000 -> 145,600,000.
  assert.equal(stepFreqAtDigit(145_500_000, 5, 1), 145_600_000);
  // Carrying past 9 digits: 999,999,000 + 100,000 = 1,000,099,000, which
  // doesn't fit in 9 digits - clamped to MAX_HZ rather than overflowing
  // silently into a wrong-looking (truncated) number.
  assert.equal(stepFreqAtDigit(999_999_000, 5, 1), MAX_HZ);
});

test("stepFreqAtDigit decrementing never goes negative", () => {
  assert.equal(stepFreqAtDigit(0, 0, -1), 0);
  assert.equal(stepFreqAtDigit(5, 0, -1), 4);
});

test("stepFreqAtDigit at the most significant digit moves by its full place value", () => {
  // digit index 8 (leftmost of 9) = the 100,000,000s place.
  assert.equal(stepFreqAtDigit(145_500_000, 8, 1), 245_500_000);
});

// The double-click-to-type-an-exact-value input ("freq-entry") this test
// used to cover was removed at the operator's request (commit
// 75e4796, "instrument: remove double-click plain-text frequency editor")
// - createDigitDisplay() no longer registers a dblclick listener at all,
// so this test (and the fakeContainer/fakeInput DOM stubs it alone used)
// started asserting on dead behaviour and was deleted here rather than
// left failing. See tests/parity-manifest.mjs's "Frequency tuning (type
// exact value)" entry, updated alongside this to stop claiming it's built.

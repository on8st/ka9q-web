import { test } from "node:test";
import assert from "node:assert/strict";
import { digitsForFreq, stepFreqAtDigit, MAX_HZ, NUM_DIGITS, createDigitDisplay } from "../../html/instrument/freq-digits.js";

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

// Minimal DOM stub - just enough to drive createDigitDisplay's event
// wiring, avoiding a full jsdom dependency (same pattern as meter.test.mjs).
function fakeContainer() {
  const listeners = {};
  return {
    classList: { add() {} },
    innerHTML: "",
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type, evt = {}) { (listeners[type] || []).forEach((fn) => fn(evt)); },
    querySelectorAll: () => [],
    appendChild() {},
  };
}

function fakeInput() {
  const listeners = {};
  return {
    id: "", className: "", value: "",
    focus() {}, select() {},
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type, evt = {}) { (listeners[type] || []).forEach((fn) => fn(evt)); },
  };
}

test("render() while the exact-value input is open does not clobber it (server echoes must not yank focus mid-type)", () => {
  const container = fakeContainer();
  let lastInput = null;
  globalThis.document = {
    createElement: () => { lastInput = fakeInput(); return lastInput; },
  };
  const { render } = createDigitDisplay(container, () => {});
  render(14_074_000);
  const htmlBeforeEdit = container.innerHTML;
  assert.ok(htmlBeforeEdit.length > 0);

  container.fire("dblclick", { stopPropagation() {} });
  assert.equal(lastInput.id, "freq-entry");
  const htmlWhileEditing = container.innerHTML; // now just holds the input, per appendChild stub

  // A server tunedFreq echo arrives while the user is still typing.
  render(14_100_000);
  assert.equal(container.innerHTML, htmlWhileEditing, "render() must not touch the DOM while editing is in progress");

  // Once the user commits, the *next* render (the real server echo for the
  // just-typed value) is free to redraw normally again.
  lastInput.value = "14.100";
  lastInput.fire("blur");
  render(14_100_000);
  assert.notEqual(container.innerHTML, htmlWhileEditing);
  assert.ok(container.innerHTML.includes(">1<") || container.innerHTML.length > 0);
});

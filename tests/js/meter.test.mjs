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

const { dbToPercent, dbToNeedleDeg, createMeter } = await import("../../html/instrument/meter.js");

test("dbToPercent clamps to [0, 100] and is linear in between", () => {
  assert.equal(dbToPercent(-80), 0);
  assert.equal(dbToPercent(0), 100);
  assert.equal(dbToPercent(-40), 50);
  assert.equal(dbToPercent(-1000), 0); // clamp below range
  assert.equal(dbToPercent(1000), 100); // clamp above range
});

test("dbToNeedleDeg maps the same range to [-60, 60] degrees", () => {
  assert.equal(dbToNeedleDeg(-80), -60);
  assert.equal(dbToNeedleDeg(0), 60);
  assert.equal(dbToNeedleDeg(-40), 0);
});

// Minimal DOM stub - just enough for createMeter's innerHTML usage,
// avoiding a full jsdom dependency for three lines of rendering logic.
function fakeContainer() {
  return { innerHTML: "" };
}

test("createMeter defaults to bar style and renders a fill width", () => {
  localStorage.clear();
  const el = fakeContainer();
  const meter = createMeter(el);
  assert.equal(meter.getStyle(), "bar");
  meter.render(-40);
  assert.match(el.innerHTML, /meter-bar-fill/);
  assert.match(el.innerHTML, /width:50\.0%/);
});

test("setStyle switches to analog and re-renders the last value, never both at once", () => {
  const el = fakeContainer();
  const meter = createMeter(el);
  meter.render(-40);
  meter.setStyle("analog");
  assert.equal(meter.getStyle(), "analog");
  assert.match(el.innerHTML, /meter-analog/);
  assert.doesNotMatch(el.innerHTML, /meter-bar-fill/);
});

test("meter style choice persists via localStorage across instances", () => {
  localStorage.clear();
  createMeter(fakeContainer()).setStyle("analog");
  const meter2 = createMeter(fakeContainer());
  assert.equal(meter2.getStyle(), "analog");
});

test("render(null) shows a placeholder instead of a stale meter", () => {
  const el = fakeContainer();
  const meter = createMeter(el);
  meter.render(-40);
  meter.render(null);
  assert.equal(el.innerHTML, "—");
});

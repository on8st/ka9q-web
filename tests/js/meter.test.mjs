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

const { dbToPercent, dbToNeedleDeg, createMeter, computeSnrDb, computeOvrRatio } = await import("../../html/instrument/meter.js");

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

test("computeSnrDb floors at -100dB when signal doesn't exceed the noise floor", () => {
  // Equal signal+noise and noise power -> ratio=1 -> ratio-1=0, not >0.
  assert.equal(computeSnrDb(-140, -140, 1), -100);
});

test("computeSnrDb rises with a stronger signal above the noise floor", () => {
  const weak = computeSnrDb(-130, -140, 1);
  const strong = computeSnrDb(-100, -140, 1);
  assert.ok(strong > weak);
});

test("computeOvrRatio pegs to 1 right after an overrange and decays toward 0", () => {
  assert.equal(computeOvrRatio(2_400_000, 2_400_000), 1); // 1 second since over, samprate 2.4Msps
  const soonAfter = computeOvrRatio(2_400_000, 2_400_000);
  const longAfter = computeOvrRatio(2_400_000, 24_000_000); // 10 seconds since
  assert.ok(longAfter < soonAfter);
});

test("computeOvrRatio clamps to [0,1] and handles missing data without throwing", () => {
  assert.equal(computeOvrRatio(2_400_000, 0), 0);
  assert.equal(computeOvrRatio(0, 1000), 0);
  assert.ok(computeOvrRatio(2_400_000, 1) <= 1); // huge ratio, clamped
});

test("createMeter defaults to the 'signal' metric and can switch to snr/ovr, persisted", () => {
  localStorage.clear();
  const meter = createMeter(fakeContainer());
  assert.equal(meter.getMetric(), "signal");
  meter.setMetric("snr");
  assert.equal(meter.getMetric(), "snr");
  const meter2 = createMeter(fakeContainer());
  assert.equal(meter2.getMetric(), "snr");
});

test("render() with SNR metric selected computes from basebandPowerDb/noiseDensityDb/bandwidthHz", () => {
  localStorage.clear();
  const el = fakeContainer();
  const meter = createMeter(el);
  meter.setMetric("snr");
  meter.render({ basebandPowerDb: -100, noiseDensityDb: -140, bandwidthHz: 1 });
  assert.match(el.innerHTML, /meter-bar-fill/);
  assert.doesNotMatch(el.innerHTML, /—/);
});

test("render() with SNR metric selected but missing inputs shows a placeholder, not a wrong reading", () => {
  localStorage.clear();
  const el = fakeContainer();
  const meter = createMeter(el);
  meter.setMetric("snr");
  meter.render({ ifPowerDb: -40 }); // only Signal's field present, not SNR's
  assert.equal(el.innerHTML, "—");
});

test("render() with OVR metric selected computes from inputSamprate/samplesSinceOver", () => {
  localStorage.clear();
  const el = fakeContainer();
  const meter = createMeter(el);
  meter.setMetric("ovr");
  meter.render({ inputSamprate: 2_400_000, samplesSinceOver: 2_400_000 });
  assert.match(el.innerHTML, /width:100\.0%/); // 1 second since over -> full scale
});

test("render(-40) (the pre-existing plain-number call shape) still works as Signal", () => {
  localStorage.clear();
  const el = fakeContainer();
  const meter = createMeter(el);
  meter.render(-40);
  assert.match(el.innerHTML, /width:50\.0%/);
});

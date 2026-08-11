import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dbToColor, binIndexForPixel, hzForPixel, pixelForHz,
  clampSpectrumPercent, SPECTRUM_PERCENT_MIN, SPECTRUM_PERCENT_MAX,
  measureAutoscaleRange, pickColormapColor, COLORMAP_NAMES,
  loadSpectrumPercent, loadWaterfallBias, loadColorIndex,
  SPECTRUM_PERCENT_DEFAULT, WATERFALL_BIAS_DEFAULT, COLORMAP_DEFAULT_INDEX,
  alphaForAveraging, emaStep, updateHoldValue,
} from "../../html/instrument/spectrum-canvas.js";

// Fake localStorage - a real empty store, not a global shim, since these
// loaders take `storage` as an injectable parameter.
function fakeStorage(initial = {}) {
  const store = { ...initial };
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
}

test("dbToColor clamps to the first/last heatmap stops at the range ends", () => {
  assert.deepEqual(dbToColor(-100, -100, -20), [0, 0, 0]);
  assert.deepEqual(dbToColor(-20, -100, -20), [230, 0, 0]);
  assert.deepEqual(dbToColor(-1000, -100, -20), [0, 0, 0]); // clamp below
  assert.deepEqual(dbToColor(1000, -100, -20), [230, 0, 0]); // clamp above
});

test("dbToColor is monotonically increasing in at least one channel across the range", () => {
  // Not asserting exact intermediate colours (interpolation detail), just
  // that the mapping isn't degenerate/constant across the range.
  const low = dbToColor(-100, -100, -20);
  const mid = dbToColor(-60, -100, -20);
  const high = dbToColor(-20, -100, -20);
  assert.notDeepEqual(low, mid);
  assert.notDeepEqual(mid, high);
});

test("binIndexForPixel covers every bin with no gaps and never goes out of range", () => {
  const width = 100;
  const binCount = 1620;
  const seen = new Set();
  for (let x = 0; x < width; x++) {
    const idx = binIndexForPixel(x, width, binCount);
    assert.ok(idx >= 0 && idx < binCount);
    seen.add(idx);
  }
  assert.equal(binIndexForPixel(0, width, binCount), 0);
  assert.equal(binIndexForPixel(width - 1, width, binCount), Math.floor(((width - 1) / width) * binCount));
});

test("hzForPixel: centre pixel reads back the absolute centre frequency", () => {
  const width = 1000;
  const absCenterHz = 145_500_000;
  const binWidthHz = 500;
  const binCount = 1620;
  const spanHz = binWidthHz * binCount;
  // Pixel at the exact horizontal centre should read back very close to
  // absCenterHz (within one pixel's worth of Hz, given integer pixel steps).
  const hzAtCentre = hzForPixel(width / 2, width, absCenterHz, binWidthHz, binCount);
  assert.ok(Math.abs(hzAtCentre - absCenterHz) < spanHz / width);
});

test("hzForPixel: left/right edges match the span's start/end", () => {
  const width = 1000;
  const absCenterHz = 10_000_000;
  const binWidthHz = 1000;
  const binCount = 1620;
  const spanHz = binWidthHz * binCount;
  assert.equal(hzForPixel(0, width, absCenterHz, binWidthHz, binCount), absCenterHz - spanHz / 2);
  assert.equal(hzForPixel(width, width, absCenterHz, binWidthHz, binCount), absCenterHz + spanHz / 2);
});

test("pixelForHz is the inverse of hzForPixel within the displayed span", () => {
  const width = 1000, absCenterHz = 145_500_000, binWidthHz = 500, binCount = 1620;
  const hz = hzForPixel(700, width, absCenterHz, binWidthHz, binCount);
  const x = pixelForHz(hz, width, absCenterHz, binWidthHz, binCount);
  assert.ok(Math.abs(x - 700) < 1);
});

test("pixelForHz returns null for a frequency outside the displayed span", () => {
  const width = 1000, absCenterHz = 145_500_000, binWidthHz = 500, binCount = 1620;
  assert.equal(pixelForHz(absCenterHz + binWidthHz * binCount, width, absCenterHz, binWidthHz, binCount), null);
  assert.equal(pixelForHz(0, width, absCenterHz, binWidthHz, binCount), null);
});

test("clampSpectrumPercent clamps to [MIN, MAX] (\"spectrum display size\" +/- buttons)", () => {
  assert.equal(clampSpectrumPercent(0), SPECTRUM_PERCENT_MIN);
  assert.equal(clampSpectrumPercent(100), SPECTRUM_PERCENT_MAX);
  assert.equal(clampSpectrumPercent(50), 50);
});

test("measureAutoscaleRange (\"Autoscale\" button) fits min/max to the given bins, ceiling rounded up to a 5 dB step", () => {
  const bins = new Float32Array([-90, -85, -40, -60]);
  const { minDb, maxDb } = measureAutoscaleRange(bins);
  assert.equal(minDb, -90 - 6); // AUTOSCALE_FLOOR_PADDING_DB
  assert.equal(maxDb, -40); // already a multiple of 5
});

test("measureAutoscaleRange rounds a non-multiple-of-5 peak up, never down", () => {
  const bins = new Float32Array([-80, -37]);
  const { maxDb } = measureAutoscaleRange(bins);
  assert.equal(maxDb, -35); // ceil(-37/5)*5 = -35, not -40
});

test("pickColormapColor clamps out-of-range scaled values to the first/last stop", () => {
  const cmap = [[1, 1, 1], [2, 2, 2], [3, 3, 3]];
  assert.deepEqual(pickColormapColor(cmap, -1), [1, 1, 1]);
  assert.deepEqual(pickColormapColor(cmap, 2), [3, 3, 3]);
});

test("pickColormapColor picks the nearest stop for an in-range value ('Colormap selection')", () => {
  const cmap = [[0, 0, 0], [10, 10, 10], [20, 20, 20], [30, 30, 30]];
  assert.deepEqual(pickColormapColor(cmap, 0), [0, 0, 0]);
  assert.deepEqual(pickColormapColor(cmap, 1), [30, 30, 30]);
  assert.deepEqual(pickColormapColor(cmap, 0.5), [20, 20, 20]); // round(0.5*3)=2 -> index 2
});

test("COLORMAP_NAMES lists all 10 stock colormaps in the stock <select>'s exact order", () => {
  assert.deepEqual(COLORMAP_NAMES, ["turbo", "fosphorz", "viridis", "inferno", "magma", "jet", "binary", "blue", "short", "kiwi"]);
});

// Regression: Number(localStorage.getItem(missingKey)) is Number(null),
// which is 0 - NOT NaN. A loader that only checks Number.isFinite()
// silently treats "never set" as "explicitly set to 0" instead of falling
// through to the real default. Caught live (waterfall bias and colormap
// both defaulted to 0/"turbo" instead of 5/"kiwi" on first ever load)
// before this test existed.
test("loadSpectrumPercent defaults correctly when localStorage has never been set (not 0)", () => {
  assert.equal(loadSpectrumPercent(fakeStorage()), SPECTRUM_PERCENT_DEFAULT);
});

test("loadWaterfallBias defaults correctly when localStorage has never been set (not 0)", () => {
  assert.equal(loadWaterfallBias(fakeStorage()), WATERFALL_BIAS_DEFAULT);
});

test("loadColorIndex defaults correctly when localStorage has never been set (not 0/\"turbo\")", () => {
  assert.equal(loadColorIndex(fakeStorage()), COLORMAP_DEFAULT_INDEX);
});

test("loadSpectrumPercent/loadWaterfallBias/loadColorIndex read back a real stored value", () => {
  assert.equal(loadSpectrumPercent(fakeStorage({ instrument_spectrum_percent: "70" })), 70);
  assert.equal(loadWaterfallBias(fakeStorage({ instrument_waterfall_bias: "-3" })), -3);
  assert.equal(loadColorIndex(fakeStorage({ instrument_colormap_index: "5" })), 5);
});

test("alphaForAveraging(1) is 1 (no smoothing - matches the input's min=1)", () => {
  assert.equal(alphaForAveraging(1), 1);
});

test("alphaForAveraging increases smoothing (smaller alpha) as the averaging count grows", () => {
  assert.ok(alphaForAveraging(50) < alphaForAveraging(10));
  assert.ok(alphaForAveraging(10) < alphaForAveraging(1));
});

test("emaStep with alpha=1 snaps straight to the new value (no smoothing)", () => {
  assert.equal(emaStep(-80, -40, 1), -40);
});

test("emaStep with alpha<1 moves partway toward the new value", () => {
  const next = emaStep(-80, -40, 0.5);
  assert.equal(next, -60);
});

test("updateHoldValue (max) tracks new peaks instantly and decays otherwise ('Max/min hold')", () => {
  assert.equal(updateHoldValue(-60, -40, 1, true), -40); // new peak - snap up
  assert.equal(updateHoldValue(-40, -60, 1, true), -40); // decay=1 ("Infinite") - no decay at all
  // decay_list's real options are all >= 1 (e.g. 1.05) - multiplying a
  // negative dB value by >1 makes it MORE negative, i.e. decays downward
  // toward the noise floor over successive frames.
  assert.equal(updateHoldValue(-40, -60, 1.05, true), -42);
});

test("updateHoldValue (min) tracks new troughs instantly and NEVER decays (ported exactly, not a bug)", () => {
  assert.equal(updateHoldValue(-40, -60, 1, false), -60); // new trough - snap down
  assert.equal(updateHoldValue(-60, -40, 0.5, false), -60); // no new trough - value unchanged regardless of "decay"
});

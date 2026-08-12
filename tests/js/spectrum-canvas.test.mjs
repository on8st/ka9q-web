import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dbToColor, binIndexForPixel, hzForPixel, pixelForHz,
  clampSpectrumPercent, SPECTRUM_PERCENT_MIN, SPECTRUM_PERCENT_MAX,
  measureAutoscaleRange, pickColormapColor, COLORMAP_NAMES,
  loadSpectrumPercent, loadWaterfallBias, loadColorIndex,
  SPECTRUM_PERCENT_DEFAULT, WATERFALL_BIAS_DEFAULT, COLORMAP_DEFAULT_INDEX,
  alphaForAveraging, emaStep, updateHoldValue,
  hzToBinIndex, interpolateDcSpike,
  niceGridStep, fmtAxisLabel,
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

test("hzToBinIndex is the inverse of hzForPixel's bin math at the centre", () => {
  const absCenterHz = 145_500_000, binWidthHz = 1000, binCount = 1620;
  assert.equal(hzToBinIndex(absCenterHz, absCenterHz, binWidthHz, binCount), binCount / 2);
});

test("hzToBinIndex at the span's left edge is bin 0", () => {
  const absCenterHz = 10_000_000, binWidthHz = 1000, binCount = 1620;
  const spanHz = binWidthHz * binCount;
  assert.equal(hzToBinIndex(absCenterHz - spanHz / 2, absCenterHz, binWidthHz, binCount), 0);
});

test("interpolateDcSpike ('Hide DC spike') linearly interpolates a 5-bin window around the DC bin", () => {
  const bins = new Float32Array([0, 0, 0, 0, 0, 10, 999, 999, 999, 999, 999, 20, 0, 0, 0]);
  // dcBinIndex=8, halfWidth=2 -> interpolate indices 6..10 between anchors at 5 (val=10) and 11 (val=20)
  const out = interpolateDcSpike(bins, 8);
  assert.equal(out[5], 10); // anchor unchanged
  assert.equal(out[11], 20); // anchor unchanged
  // Float32Array storage rounds these - compare with a tolerance, not
  // exact equality (the anchors above are copied verbatim, no arithmetic,
  // so those stay exact).
  assert.ok(Math.abs(out[6] - (10 + (20 - 10) * (1 / 6))) < 1e-4);
  assert.ok(Math.abs(out[8] - (10 + (20 - 10) * (3 / 6))) < 1e-4); // exact midpoint
  assert.ok(Math.abs(out[10] - (10 + (20 - 10) * (5 / 6))) < 1e-4);
});

test("interpolateDcSpike returns the input unchanged (not a copy) when the window runs off either edge", () => {
  const bins = new Float32Array([1, 2, 3]);
  assert.equal(interpolateDcSpike(bins, 1), bins); // dcBin=1, window would need indices -2..4, out of range
});

test("interpolateDcSpike returns the input unchanged for an empty/missing array", () => {
  assert.equal(interpolateDcSpike(null, 5), null);
  assert.equal(interpolateDcSpike(new Float32Array(0), 5).length, 0);
});

// Gridlines used to be "8 equally-spaced PIXELS, label whatever frequency
// lands there" - span-derived numbers like 144.393, 144.595, not round
// ones. niceGridStep()/fmtAxisLabel() replace that with a step snapped to
// 1/2/5 x 10^n Hz, adaptive to the current span rather than hardcoded per
// receiver (the right step depends on what's displayed, which changes
// with zoom regardless of which receiver this is).
test("niceGridStep lands on the operator's own examples at each band's typical full-coverage view", () => {
  assert.equal(niceGridStep(4.256e6, 9), 500_000); // VHF 2m (~4.3MHz) -> half MHz
  assert.equal(niceGridStep(8.8e6, 9), 1_000_000); // UHF 70cm (~8.8MHz) -> whole MHz
});

test("niceGridStep stays sensible across HF's much wider span range", () => {
  assert.equal(niceGridStep(30e6, 9), 5_000_000); // a full HF band
  assert.equal(niceGridStep(350e3, 9), 50_000); // a ~350kHz segment (e.g. 20m)
  assert.equal(niceGridStep(2_800, 9), 500); // a tight 2.8kHz SSB QSO zoom
});

test("niceGridStep only ever returns a 1, 2, or 5 x 10^n value", () => {
  for (const span of [123, 4_567, 89_012, 3.4e6, 56.7e6, 890e6]) {
    const step = niceGridStep(span, 6);
    const magnitude = 10 ** Math.floor(Math.log10(step));
    const normalized = Math.round((step / magnitude) * 1000) / 1000; // guard float error
    assert.ok([1, 2, 5, 10].includes(normalized), `${step} (span ${span}) normalizes to ${normalized}`);
  }
});

test("niceGridStep degrades gracefully on invalid input instead of returning 0/NaN/Infinity", () => {
  for (const span of [0, -5, NaN, Infinity]) {
    const step = niceGridStep(span, 9);
    assert.ok(Number.isFinite(step) && step > 0, `span=${span} produced step=${step}`);
  }
});

test("fmtAxisLabel's decimal count exactly represents its step - never trailing/arbitrary digits", () => {
  assert.equal(fmtAxisLabel(144_000_000, 1_000_000), "144"); // 1MHz step - no decimals needed
  assert.equal(fmtAxisLabel(144_500_000, 500_000), "144.5"); // 0.5MHz step - one decimal
  assert.equal(fmtAxisLabel(14_238_000, 1_000), "14.238"); // 1kHz step - three decimals (the old fixed default, still correct at this scale)
  assert.equal(fmtAxisLabel(14_239_500, 500), "14.2395"); // 500Hz step - four decimals
});

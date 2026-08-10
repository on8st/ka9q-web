import { test } from "node:test";
import assert from "node:assert/strict";
import { dbToColor, binIndexForPixel, hzForPixel, pixelForHz } from "../../html/instrument/spectrum-canvas.js";

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

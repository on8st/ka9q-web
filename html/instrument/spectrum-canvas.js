// Live spectrum trace + waterfall, filling #display-area per the design
// brief ("the receiver fills the screen... nothing floats over them").
// One canvas doing both (top = trace, bottom = waterfall), gridlines with
// real frequency labels, and a highlighted band at the tuned frequency -
// matching the approved design mockup's #scope exactly. The mockup's own
// canvas painting is explicitly throwaway (brief section 2); this reads
// real decoded data instead of the mockup's illustrative random noise.

const HEATMAP_STOPS = [
  [0, 0, 0],
  [0, 0, 180],
  [0, 200, 200],
  [230, 230, 0],
  [230, 0, 0],
];

export function dbToColor(db, minDb, maxDb) {
  const t = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
  const scaled = t * (HEATMAP_STOPS.length - 1);
  const i = Math.min(HEATMAP_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - i;
  const [r0, g0, b0] = HEATMAP_STOPS[i];
  const [r1, g1, b1] = HEATMAP_STOPS[i + 1];
  return [
    Math.round(r0 + (r1 - r0) * frac),
    Math.round(g0 + (g1 - g0) * frac),
    Math.round(b0 + (b1 - b0) * frac),
  ];
}

/** Which bin index a pixel column maps to, for a canvas `width` px wide
 * showing `binCount` bins. Floors rather than rounds so every pixel maps
 * to exactly one bin with no gaps at the edges. */
export function binIndexForPixel(x, width, binCount) {
  return Math.min(binCount - 1, Math.max(0, Math.floor((x / width) * binCount)));
}

/** hz shown at a given pixel column, given the absolute (already
 * FIRST_LO_FREQUENCY-corrected - see spectrum-decode.js) centre. */
export function hzForPixel(x, width, absCenterHz, binWidthHz, binCount) {
  const spanHz = binWidthHz * binCount;
  const startHz = absCenterHz - spanHz / 2;
  return startHz + (x / width) * spanHz;
}

/** Inverse of hzForPixel - which pixel column a given absolute frequency
 * falls at, or null if it's outside the displayed span. */
export function pixelForHz(hz, width, absCenterHz, binWidthHz, binCount) {
  const spanHz = binWidthHz * binCount;
  const startHz = absCenterHz - spanHz / 2;
  const x = ((hz - startHz) / spanHz) * width;
  return x >= 0 && x <= width ? x : null;
}

function fmtAxisLabel(hz) {
  return (hz / 1e6).toFixed(3);
}

// "Spectrum display size" (stock: spectrum_size_up/spectrum_size_down,
// html/spectrum.js's incrementSpectrumPercent()/decrementSpectrumPercent())
// is purely a local trace/waterfall split ratio - confirmed no WS traffic
// exists for it in the stock UI, just canvas geometry + localStorage.
export const SPECTRUM_PERCENT_MIN = 10;
export const SPECTRUM_PERCENT_MAX = 90;
export const SPECTRUM_PERCENT_DEFAULT = 46;
export const SPECTRUM_PERCENT_STEP = 5;
const SPECTRUM_PERCENT_KEY = "instrument_spectrum_percent";

export function clampSpectrumPercent(pct) {
  return Math.min(SPECTRUM_PERCENT_MAX, Math.max(SPECTRUM_PERCENT_MIN, pct));
}

function loadSpectrumPercent() {
  const raw = Number(localStorage.getItem(SPECTRUM_PERCENT_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampSpectrumPercent(raw) : SPECTRUM_PERCENT_DEFAULT;
}

// "Spectrum autoscale" (stock: autoscale button, Spectrum.prototype.
// measureMinMax()) - a one-shot fit-to-current-data snapshot, not a
// continuous mode (unlike this UI's own always-on smoothed autorange
// above). Ported simplified: real min/max of the current bins, max
// rounded up to the next 5 dB step (stock's own rounding), min padded by
// a few dB of headroom so the trace isn't flush against the bottom edge.
const AUTOSCALE_FLOOR_PADDING_DB = 6;

export function measureAutoscaleRange(binsDb) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < binsDb.length; i++) {
    if (binsDb[i] < min) min = binsDb[i];
    if (binsDb[i] > max) max = binsDb[i];
  }
  return {
    minDb: min - AUTOSCALE_FLOOR_PADDING_DB,
    maxDb: Math.ceil(max / 5) * 5,
  };
}

// How fast the autorange floor/ceiling adapts to the real incoming data
// (0 = never moves, 1 = snaps instantly to the latest frame). Smoothed
// rather than snapping so the display doesn't flicker frame to frame.
const AUTORANGE_SMOOTHING = 0.15;
const AUTORANGE_PADDING_DB = 4;

export function createSpectrumDisplay(container) {
  container.innerHTML = "";
  container.classList.add("spectrum-display");
  const canvas = document.createElement("canvas");
  canvas.id = "scope";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // Deliberately NOT using ctx.setTransform(dpr,...) to size this crisply
  // on high-DPI screens: putImageData/createImageData (used for the
  // waterfall rows below) always operate on raw backing-store pixels and
  // ignore the current transform entirely, unlike fillRect/lineTo/stroke.
  // Mixing the two - draw in CSS-pixel space via a transform, then
  // putImageData assuming the same coordinates - silently writes rows at
  // the wrong scale and position on any DPR != 1 display. Confirmed live:
  // the trace rendered fine while the waterfall stayed permanently black.
  // Simplest correct fix: do all math in raw canvas.width/height pixels,
  // no transform, ever.
  function resize() {
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }
  resize();
  new ResizeObserver(resize).observe(container);

  let paused = false;
  let lastSpectrum = null;
  let tunedFreqHz = null;
  let manualRange = null; // {minDb, maxDb} once the operator sets one explicitly
  let smoothMinDb = null;
  let smoothMaxDb = null;
  let spectrumPercent = loadSpectrumPercent();

  function setSpectrumPercent(pct) {
    spectrumPercent = clampSpectrumPercent(pct);
    localStorage.setItem(SPECTRUM_PERCENT_KEY, String(spectrumPercent));
    if (!paused) draw();
  }

  function updateAutorange(binsDb) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < binsDb.length; i++) {
      if (binsDb[i] < min) min = binsDb[i];
      if (binsDb[i] > max) max = binsDb[i];
    }
    if (smoothMinDb === null) {
      smoothMinDb = min;
      smoothMaxDb = max;
    } else {
      smoothMinDb += (min - smoothMinDb) * AUTORANGE_SMOOTHING;
      smoothMaxDb += (max - smoothMaxDb) * AUTORANGE_SMOOTHING;
    }
  }

  function currentRange() {
    if (manualRange) return manualRange;
    if (smoothMinDb === null) return { minDb: -100, maxDb: -20 };
    return { minDb: smoothMinDb - AUTORANGE_PADDING_DB, maxDb: smoothMaxDb + AUTORANGE_PADDING_DB };
  }

  function setRangeInternal(minDb, maxDb) {
    manualRange = { minDb, maxDb };
    if (!paused) draw();
  }

  /** Ported from stock's Autoscale button: snapshot-fits the range to
   * whatever's in the last received frame right now, then holds it there
   * (a one-shot fixed range, same as manually setting one - not this UI's
   * usual continuous smoothing, matching stock's own one-shot behaviour). */
  function forceAutoscale() {
    if (!lastSpectrum) return;
    const { minDb, maxDb } = measureAutoscaleRange(lastSpectrum.binsDb);
    setRangeInternal(minDb, maxDb);
  }

  /** Ported from stock's baseline_up/baseline_down buttons: nudge the
   * floor (min_db) by 5 dB, independent of the ceiling. Materializes the
   * current (possibly still auto-computed) range into a fixed one first,
   * same as stock always operating on a concrete min_db/max_db pair. */
  function baselineUp() {
    const { minDb, maxDb } = currentRange();
    setRangeInternal(minDb - 5, maxDb);
  }
  function baselineDown() {
    const { minDb, maxDb } = currentRange();
    setRangeInternal(minDb + 5, maxDb);
  }

  /** Ported from stock's rangeinc/rangedec buttons: nudge the ceiling
   * (max_db) by 5 dB. rangeDecrease refuses to shrink below a 10 dB span,
   * matching stock exactly. */
  function rangeIncrease() {
    const { minDb, maxDb } = currentRange();
    setRangeInternal(minDb, maxDb + 5);
  }
  function rangeDecrease() {
    const { minDb, maxDb } = currentRange();
    if (maxDb - minDb > 10) setRangeInternal(minDb, maxDb - 5);
  }

  function draw() {
    if (!lastSpectrum) return;
    const { binsDb, centerHz, binWidthHz, binCount } = lastSpectrum;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    if (w < 4 || h < 4) return;
    const splitY = h * (spectrumPercent / 100);
    const { minDb, maxDb } = currentRange();

    // Only the trace region gets wiped each frame - the waterfall region
    // below it is never blanket-cleared, only scrolled (see below). An
    // earlier version cleared the whole canvas here, which wiped out the
    // waterfall's own history a split second before trying to scroll it -
    // confirmed live: the trace rendered correctly while the waterfall
    // stayed permanently black.
    ctx.fillStyle = "#04060A";
    ctx.fillRect(0, 0, w, splitY);

    // Waterfall: scroll existing content down 1px, draw the newest row at
    // the top of the waterfall region (matches the mockup's newest-on-top
    // convention).
    const wfTop = Math.floor(splitY);
    const wfH = Math.floor(h - splitY);
    if (wfH > 1) {
      ctx.drawImage(canvas, 0, wfTop, w, wfH - 1, 0, wfTop + 1, w, wfH - 1);
    }
    if (wfH > 0) {
      const row = ctx.createImageData(w, 1);
      for (let x = 0; x < w; x++) {
        const db = binsDb[binIndexForPixel(x, w, binCount)];
        const [r, g, b] = dbToColor(db, minDb, maxDb);
        row.data[x * 4] = r;
        row.data[x * 4 + 1] = g;
        row.data[x * 4 + 2] = b;
        row.data[x * 4 + 3] = 255;
      }
      ctx.putImageData(row, 0, wfTop);
    }

    // Trace, filled below the line (matches the mockup's phosphor-green look).
    ctx.beginPath();
    ctx.moveTo(0, splitY);
    for (let x = 0; x < w; x++) {
      const db = binsDb[binIndexForPixel(x, w, binCount)];
      const t = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
      ctx.lineTo(x, splitY - t * (splitY - 14));
    }
    ctx.lineTo(w, splitY);
    ctx.closePath();
    ctx.fillStyle = "rgba(75,224,138,0.10)";
    ctx.fill();
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const db = binsDb[binIndexForPixel(x, w, binCount)];
      const t = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
      const y = splitY - t * (splitY - 14);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#4BE08A";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Tuned-frequency band, spanning the full height (matches the mockup).
    if (tunedFreqHz !== null) {
      const x = pixelForHz(tunedFreqHz, w, centerHz, binWidthHz, binCount);
      if (x !== null) {
        ctx.fillStyle = "rgba(86,199,255,0.13)";
        ctx.fillRect(x - w * 0.0175, 0, w * 0.035, h);
        ctx.strokeStyle = "#56C7FF";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // Gridlines + real frequency axis labels (not the mockup's illustrative
    // fixed-span math - these use the actual decoded span).
    ctx.strokeStyle = "rgba(42,52,65,0.9)";
    ctx.fillStyle = "#78879A";
    ctx.font = `${9 * dpr}px ui-monospace,monospace`;
    for (let i = 1; i < 8; i++) {
      const x = (w / 8) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, splitY);
      ctx.stroke();
      const hz = hzForPixel(x, w, centerHz, binWidthHz, binCount);
      ctx.fillText(fmtAxisLabel(hz), x - 16 * dpr, splitY - 4 * dpr);
    }
  }

  return {
    render: (spectrum) => {
      lastSpectrum = spectrum;
      updateAutorange(spectrum.binsDb);
      if (!paused) draw();
    },
    resize,
    setRange: setRangeInternal,
    getRange: () => currentRange(),
    clearManualRange: () => { manualRange = null; },
    setPaused: (v) => { paused = v; },
    isPaused: () => paused,
    setTunedFreqHz: (hz) => { tunedFreqHz = hz; if (!paused) draw(); },
    getLastSpectrum: () => lastSpectrum,
    setSpectrumPercent,
    getSpectrumPercent: () => spectrumPercent,
    incrementSpectrumPercent: () => setSpectrumPercent(spectrumPercent + SPECTRUM_PERCENT_STEP),
    decrementSpectrumPercent: () => setSpectrumPercent(spectrumPercent - SPECTRUM_PERCENT_STEP),
    forceAutoscale,
    baselineUp,
    baselineDown,
    rangeIncrease,
    rangeDecrease,
    canvas,
  };
}

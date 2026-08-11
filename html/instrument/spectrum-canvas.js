// Live spectrum trace + waterfall, filling #display-area per the design
// brief ("the receiver fills the screen... nothing floats over them").
// One canvas doing both (top = trace, bottom = waterfall), gridlines with
// real frequency labels, and a highlighted band at the tuned frequency -
// matching the approved design mockup's #scope exactly. The mockup's own
// canvas painting is explicitly throwaway (brief section 2); this reads
// real decoded data instead of the mockup's illustrative random noise.

import { bandEdgesInSpan } from "./band-edges.js";

const HEATMAP_STOPS = [
  [0, 0, 0],
  [0, 0, 180],
  [0, 200, 200],
  [230, 230, 0],
  [230, 0, 0],
];

// "Colormap selection" (stock: html/colormap.js's `colormaps` array,
// selected via the `colormap` <select>). Reused as-is via a classic
// <script> tag (html/instrument/index.html loads ../colormap.js) rather
// than re-deriving ~2500 RGB triples by hand - `window.colormaps` is the
// same 10-entry array stock uses. Falls back to the built-in HEATMAP_STOPS
// gradient below if that script hasn't loaded (defensive only; it always
// does in the real deployed page).
export const COLORMAP_NAMES = ["turbo", "fosphorz", "viridis", "inferno", "magma", "jet", "binary", "blue", "short", "kiwi"];
export const COLORMAP_DEFAULT_INDEX = 9; // "kiwi" - matches stock's own default (Spectrum constructor)

/** Picks a colour from a stock colormap array (list of [r,g,b] stops) for
 * a 0..1 normalized value. */
export function pickColormapColor(cmap, scaled) {
  const t = Math.min(1, Math.max(0, scaled));
  const idx = Math.round(t * (cmap.length - 1));
  return cmap[idx] || cmap[cmap.length - 1] || [0, 0, 0];
}

// "FFT averaging amount" (stock: fft_avg_input, Spectrum.prototype.
// setAveraging()/drawSpectrum()) - a CLIENT-SIDE exponential moving
// average of the already-received bins, distinct from the real wire
// command "spectrum_average_input" sends (ws-client.js's
// setSpectrumAverage(), server-side radiod averaging - a different
// feature despite the similar name, confirmed by research before
// porting: only one of the two ever touches the WS).
export function alphaForAveraging(n) {
  return 2 / (n + 1);
}

export function emaStep(prev, raw, alpha) {
  return prev + alpha * (raw - prev);
}

// "Max/min hold" (stock: max_hold/check_max/check_min/check_live/
// decay_list) - per-bin hold-trace update, ported exactly from
// Spectrum.prototype.drawSpectrum()'s two update loops. Min-hold's
// "decay" is a deliberate no-op in stock (min-hold never decays, only
// max-hold does, via decay_list) - ported faithfully, not a bug.
export function updateHoldValue(prev, raw, decay, isMax) {
  if (isMax) return raw > prev ? raw : decay * prev;
  return raw < prev ? raw : prev;
}

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

/** Which bin index a given absolute frequency falls in (not clamped to
 * the display width, unlike binIndexForPixel - used for "Hide DC spike",
 * which needs the bin index directly, not a pixel column). */
export function hzToBinIndex(hz, absCenterHz, binWidthHz, binCount) {
  const spanHz = binWidthHz * binCount;
  const startHz = absCenterHz - spanHz / 2;
  return Math.round(((hz - startHz) / spanHz) * binCount);
}

// "Hide DC/centre-bin spike" (this fork's own stock feature,
// ckHideDcSpike) - cosmetic-only linear interpolation over the front
// end's own LO-leakage spike, ported exactly from spectrum.js's
// interpolateDcSpike(): a halfWidth=2 window (5 bins) around the DC bin,
// interpolated between the two real bins just outside it. Returns the
// input unchanged (no copy) whenever there's nothing to do, so callers
// never need to null-check - same contract as stock.
export function interpolateDcSpike(binsDb, dcBinIndex) {
  if (!binsDb || !binsDb.length) return binsDb;
  const halfWidth = 2;
  const lo = dcBinIndex - halfWidth;
  const hi = dcBinIndex + halfWidth;
  if (lo - 1 < 0 || hi + 1 >= binsDb.length) return binsDb;
  const leftVal = binsDb[lo - 1];
  const rightVal = binsDb[hi + 1];
  if (!Number.isFinite(leftVal) || !Number.isFinite(rightVal)) return binsDb;
  const out = binsDb.slice();
  const span = (hi + 1) - (lo - 1);
  for (let i = lo; i <= hi; i++) {
    out[i] = leftVal + (rightVal - leftVal) * ((i - (lo - 1)) / span);
  }
  return out;
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

export function loadSpectrumPercent(storage = localStorage) {
  const stored = storage.getItem(SPECTRUM_PERCENT_KEY);
  if (stored === null) return SPECTRUM_PERCENT_DEFAULT;
  const raw = Number(stored);
  return Number.isFinite(raw) && raw > 0 ? clampSpectrumPercent(raw) : SPECTRUM_PERCENT_DEFAULT;
}

// "Waterfall colour bias" (stock: waterfallBiasInput) - a plain offset
// added to the floor (minDb) used for the WATERFALL's colour mapping
// only, not the trace (ported exactly: html/spectrum.js's setRange()
// computes wf_min_db = min_db + waterfallBias while the trace keeps
// min_db unmodified). Default 5, matching stock's Spectrum constructor.
export const WATERFALL_BIAS_DEFAULT = 5;
const WATERFALL_BIAS_KEY = "instrument_waterfall_bias";
const COLORMAP_INDEX_KEY = "instrument_colormap_index";

// Exported so the "localStorage not set yet -> real default, not 0"
// behaviour is directly unit-testable without a full canvas/DOM stub -
// Number(localStorage.getItem(missingKey)) is Number(null) which is 0,
// NOT NaN, so a naive Number.isFinite()-only guard silently accepts an
// unset key as "0" instead of falling through to the real default (this
// bit both of these on first write - caught live, not by a test, which
// is exactly why they're pure/exported now).
export function loadWaterfallBias(storage = localStorage) {
  const stored = storage.getItem(WATERFALL_BIAS_KEY);
  if (stored === null) return WATERFALL_BIAS_DEFAULT;
  const raw = Number(stored);
  return Number.isFinite(raw) ? raw : WATERFALL_BIAS_DEFAULT;
}

export function loadColorIndex(storage = localStorage) {
  const stored = storage.getItem(COLORMAP_INDEX_KEY);
  if (stored === null) return COLORMAP_DEFAULT_INDEX;
  const raw = Number(stored);
  return Number.isInteger(raw) && raw >= 0 && raw < COLORMAP_NAMES.length ? raw : COLORMAP_DEFAULT_INDEX;
}

// Small persisted-setting helpers for the many display toggles below (FFT
// averaging, max/min hold, live/max/min trace visibility, fill style, DC
// spike hiding, band edges, cursor) - none of these survived a page reload
// before (reported live 2026-08-11): each setter only touched its
// in-memory variable, so every reload silently reverted to the hardcoded
// defaults regardless of what the operator had set via the context menu.
function loadBool(key, def, storage = localStorage) {
  const stored = storage.getItem(key);
  return stored === null ? def : stored === "1";
}
function saveBool(key, v, storage = localStorage) {
  storage.setItem(key, v ? "1" : "0");
}
function loadNumber(key, def, storage = localStorage) {
  const stored = storage.getItem(key);
  if (stored === null) return def;
  const raw = Number(stored);
  return Number.isFinite(raw) ? raw : def;
}
function saveNumber(key, v, storage = localStorage) {
  storage.setItem(key, String(v));
}

const FFT_AVERAGING_KEY = "instrument_fft_averaging";
const MAX_HOLD_ENABLED_KEY = "instrument_max_hold_enabled";
const HOLD_DECAY_KEY = "instrument_hold_decay";
const FREEZE_MIN_MAX_KEY = "instrument_freeze_min_max";
const SHOW_LIVE_KEY = "instrument_show_live";
const SHOW_MAX_TRACE_KEY = "instrument_show_max_trace";
const SHOW_MIN_TRACE_KEY = "instrument_show_min_trace";
const NO_FILL_KEY = "instrument_no_fill";
const HIDE_DC_SPIKE_KEY = "instrument_hide_dc_spike";
const SHOW_BAND_EDGES_KEY = "instrument_show_band_edges";
const CURSOR_ACTIVE_KEY = "instrument_cursor_active";

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

export function createSpectrumDisplay(container, { onTune } = {}) {
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
  let waterfallBias = loadWaterfallBias();
  let colorIndex = loadColorIndex();

  function setSpectrumPercent(pct) {
    spectrumPercent = clampSpectrumPercent(pct);
    localStorage.setItem(SPECTRUM_PERCENT_KEY, String(spectrumPercent));
    if (!paused) draw();
  }

  function setWaterfallBias(bias) {
    waterfallBias = Number(bias);
    if (!Number.isFinite(waterfallBias)) waterfallBias = WATERFALL_BIAS_DEFAULT;
    localStorage.setItem(WATERFALL_BIAS_KEY, String(waterfallBias));
    if (!paused) draw();
  }

  function setColorIndex(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= COLORMAP_NAMES.length) return;
    colorIndex = idx;
    localStorage.setItem(COLORMAP_INDEX_KEY, String(colorIndex));
    if (!paused) draw();
  }

  function waterfallColor(db, minDb, maxDb) {
    const cmap = (typeof window !== "undefined" && window.colormaps) ? window.colormaps[colorIndex] : null;
    if (!cmap) return dbToColor(db, minDb, maxDb);
    const wfMinDb = minDb + waterfallBias;
    const denom = maxDb - wfMinDb;
    const scaled = denom !== 0 ? (db - wfMinDb) / denom : 0;
    return pickColormapColor(cmap, scaled);
  }

  // "FFT averaging amount" - client-side EMA, applied before the trace/
  // waterfall are drawn (both consume the averaged bins, matching stock -
  // see alphaForAveraging()'s header comment for the real-wire-command
  // sibling this is NOT).
  let fftAveraging = loadNumber(FFT_AVERAGING_KEY, 1); // 1 = no smoothing, matches the stock input's min
  let binsAverage = null; // Float32Array, lazily (re)sized to match binCount

  function setFftAveraging(n) {
    fftAveraging = Math.max(1, Number(n) || 1);
    saveNumber(FFT_AVERAGING_KEY, fftAveraging);
  }

  // "Max/min hold" state - ported from Spectrum.prototype's maxHold/
  // decay/freezeMinMax/binsMax/binsMin (see updateHoldValue() above).
  let maxHoldEnabled = loadBool(MAX_HOLD_ENABLED_KEY, true); // stock default (radio.js's setDefaultSettings())
  let holdDecay = loadNumber(HOLD_DECAY_KEY, 1); // "Infinite" - stock default
  let freezeMinMax = loadBool(FREEZE_MIN_MAX_KEY, false);
  let showLive = loadBool(SHOW_LIVE_KEY, true);
  let showMaxTrace = loadBool(SHOW_MAX_TRACE_KEY, false);
  let showMinTrace = loadBool(SHOW_MIN_TRACE_KEY, false);
  let binsMax = null;
  let binsMin = null;

  function setMaxHoldEnabled(v) {
    maxHoldEnabled = !!v;
    saveBool(MAX_HOLD_ENABLED_KEY, maxHoldEnabled);
    binsMax = null; // reseed fresh next frame, matches stock's setMaxHold()
    binsMin = null;
  }
  function setHoldDecay(v) { holdDecay = Number(v) || 1; saveNumber(HOLD_DECAY_KEY, holdDecay); }
  function setFreezeMinMax(v) { freezeMinMax = !!v; saveBool(FREEZE_MIN_MAX_KEY, freezeMinMax); }
  function setShowLive(v) { showLive = !!v; saveBool(SHOW_LIVE_KEY, showLive); if (!paused) draw(); }
  function setShowMaxTrace(v) { showMaxTrace = !!v; saveBool(SHOW_MAX_TRACE_KEY, showMaxTrace); if (!paused) draw(); }
  function setShowMinTrace(v) { showMinTrace = !!v; saveBool(SHOW_MIN_TRACE_KEY, showMinTrace); if (!paused) draw(); }

  // "Spectrum fill style" (ckNoSpectrumFill) - gates only the live
  // trace's under-curve fill, not its stroke, matching stock exactly
  // (max/min hold traces are never filled in stock either way).
  let noFill = loadBool(NO_FILL_KEY, false);
  function setNoFill(v) { noFill = !!v; saveBool(NO_FILL_KEY, noFill); if (!paused) draw(); }

  // "Hide DC/centre-bin spike" - needs the front end's real tuned centre
  // (FIRST_LO_FREQUENCY, same field the frequency-offset fix already
  // needed - see PROTOCOL-SPECTRUM.md) to know which bin is DC.
  let hideDcSpike = loadBool(HIDE_DC_SPIKE_KEY, true); // stock default
  let frontendFrequencyHz = null;
  function setHideDcSpike(v) { hideDcSpike = !!v; saveBool(HIDE_DC_SPIKE_KEY, hideDcSpike); }
  function setFrontendFrequencyHz(hz) { frontendFrequencyHz = hz; }

  // "Show ham band edge markers" - see band-edges.js for the table.
  let showBandEdges = loadBool(SHOW_BAND_EDGES_KEY, false);
  function setShowBandEdges(v) { showBandEdges = !!v; saveBool(SHOW_BAND_EDGES_KEY, showBandEdges); if (!paused) draw(); }

  // "Cursor" - a display-only frequency marker (distinct from tuning),
  // ported from spectrum.js's cursor_active/cursor_freq/drawCursor().
  // cursorFreqHz itself is deliberately NOT persisted - it's a transient
  // reference point tied to the current session's clicks, not a setting.
  let cursorActive = loadBool(CURSOR_ACTIVE_KEY, false);
  let cursorFreqHz = null;
  function setCursorActive(v) { cursorActive = !!v; saveBool(CURSOR_ACTIVE_KEY, cursorActive); if (!paused) draw(); }
  function setCursorFreqHz(hz) { cursorFreqHz = hz; if (!paused) draw(); }
  // Click-to-tune (prerequisite for "Keep frequency centred"/AZC, which
  // just conditionally follows this with a zoomCenter - ported from
  // spectrum.js's mouseup handler, minus its drag-distance/duration
  // thresholds since this UI has no drag-to-pan yet to distinguish from).
  // Cursor-active takes priority, matching stock: a click sets the cursor
  // marker instead of tuning when the cursor is turned on.
  canvas.addEventListener("click", (e) => {
    if (!lastSpectrum) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr;
    const hz = hzForPixel(x, canvas.width, lastSpectrum.centerHz, lastSpectrum.binWidthHz, lastSpectrum.binCount);
    if (cursorActive) setCursorFreqHz(hz);
    else if (onTune) onTune(hz);
  });

  /** Applies DC-spike interpolation (cosmetic only) then FFT averaging,
   * then, if enabled, updates the max/min-hold arrays - once per
   * incoming frame, before drawing. Returns the bins the trace/waterfall
   * should actually render. */
  function processFrame(spectrum) {
    let binsDb = spectrum.binsDb;
    if (hideDcSpike && typeof frontendFrequencyHz === "number" && frontendFrequencyHz > 0) {
      const dcBin = hzToBinIndex(frontendFrequencyHz, spectrum.centerHz, spectrum.binWidthHz, spectrum.binCount);
      binsDb = interpolateDcSpike(binsDb, dcBin);
    }
    if (!binsAverage || binsAverage.length !== binsDb.length) {
      binsAverage = Float32Array.from(binsDb);
    } else {
      const alpha = alphaForAveraging(fftAveraging);
      for (let i = 0; i < binsDb.length; i++) binsAverage[i] = emaStep(binsAverage[i], binsDb[i], alpha);
    }
    if (maxHoldEnabled) {
      if (!binsMax || binsMax.length !== binsAverage.length) binsMax = Float32Array.from(binsAverage);
      if (!binsMin || binsMin.length !== binsAverage.length) binsMin = Float32Array.from(binsAverage);
      if (!freezeMinMax) {
        for (let i = 0; i < binsAverage.length; i++) {
          binsMax[i] = updateHoldValue(binsMax[i], binsAverage[i], holdDecay, true);
          binsMin[i] = updateHoldValue(binsMin[i], binsAverage[i], holdDecay, false);
        }
      }
    }
    return binsAverage;
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
    const { centerHz, binWidthHz, binCount } = lastSpectrum;
    const binsDb = binsAverage || lastSpectrum.binsDb; // FFT-averaged trace/waterfall source (see processFrame())
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
        const [r, g, b] = waterfallColor(db, minDb, maxDb);
        row.data[x * 4] = r;
        row.data[x * 4 + 1] = g;
        row.data[x * 4 + 2] = b;
        row.data[x * 4 + 3] = 255;
      }
      ctx.putImageData(row, 0, wfTop);
    }

    // Trace, filled below the line (matches the mockup's phosphor-green
    // look). "Live" trace visibility (check_live) - drawn regardless of
    // maxHoldEnabled, matching stock exactly (only Max/Min are gated by it).
    if (showLive) {
      // "Spectrum fill style" (ckNoSpectrumFill) - only skips the fill,
      // the stroke below always draws (matches stock exactly). Baseline
      // is wfTop (the integer row the waterfall actually starts at), NOT
      // the fractional splitY: splitY can land mid-pixel (e.g. 399.5),
      // and an antialiased fill/stroke reaching down to a fractional y
      // partially paints the row AT wfTop = floor(splitY) - the same row
      // the waterfall just wrote its freshest data into, a few lines
      // above. That tinted the waterfall's very first (newest) row a
      // visibly different shade from the rows below it every frame -
      // reported live as a "dampened"/bright top row (2026-08-11).
      if (!noFill) {
        ctx.beginPath();
        ctx.moveTo(0, wfTop);
        for (let x = 0; x < w; x++) {
          const db = binsDb[binIndexForPixel(x, w, binCount)];
          const t = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
          ctx.lineTo(x, wfTop - t * (wfTop - 14));
        }
        ctx.lineTo(w, wfTop);
        ctx.closePath();
        ctx.fillStyle = "rgba(75,224,138,0.10)";
        ctx.fill();
      }
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const db = binsDb[binIndexForPixel(x, w, binCount)];
        const t = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
        const y = wfTop - t * (wfTop - 14);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#4BE08A";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Max/Min hold overlay traces - both gated on maxHoldEnabled AND their
    // own visibility checkbox, exactly matching stock's
    // `(this.maxHold) && (check_max.checked)` / same for check_min.
    function strokeHoldTrace(arr, color) {
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const db = arr[binIndexForPixel(x, w, binCount)];
        const t = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
        const y = wfTop - t * (wfTop - 14);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (maxHoldEnabled && showMaxTrace && binsMax) strokeHoldTrace(binsMax, "#ffff00");
    if (maxHoldEnabled && showMinTrace && binsMin) strokeHoldTrace(binsMin, "#ff0000");

    // "Cursor" - a display-only frequency marker, ported from
    // spectrum.js's drawCursor(). Independent of the tuned-frequency band
    // above (different colour, different purpose - a movable reference
    // point vs. the actual receive frequency).
    if (cursorActive && cursorFreqHz !== null) {
      const x = pixelForHz(cursorFreqHz, w, centerHz, binWidthHz, binCount);
      if (x !== null) {
        ctx.strokeStyle = "#00ffff";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, wfTop);
        ctx.stroke();
      }
    }

    // Tuned-frequency band: confined entirely to the trace region
    // (0..wfTop), never the waterfall below. That region is fully
    // repainted every frame, but the waterfall only ever scrolls its
    // existing pixels - anything drawn into it here (even just the thin
    // line) gets redrawn onto the SAME still-visible rows on every
    // subsequent frame and freezes into a permanent streak once those rows
    // scroll out of view. An earlier version let the line span full height
    // as an intentional "trail"; live use showed that read as a stray,
    // out-of-place mark cutting through the waterfall rather than a
    // deliberate feature, so it's confined like the fill (2026-08-11).
    if (tunedFreqHz !== null) {
      const x = pixelForHz(tunedFreqHz, w, centerHz, binWidthHz, binCount);
      if (x !== null) {
        ctx.fillStyle = "rgba(86,199,255,0.13)";
        ctx.fillRect(x - w * 0.0175, 0, w * 0.035, wfTop);
        ctx.strokeStyle = "#56C7FF";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, wfTop);
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
      ctx.lineTo(x, wfTop);
      ctx.stroke();
      const hz = hzForPixel(x, w, centerHz, binWidthHz, binCount);
      ctx.fillText(fmtAxisLabel(hz), x - 16 * dpr, wfTop - 4 * dpr);
    }

    // "Show ham band edge markers" - ported from spectrum.js's
    // updateAxes()/getHamBands(): a bright green line at each edge of
    // every band overlapping the displayed span, full trace height, plus
    // a centered label when there's room. Simplified from stock's own
    // version by dropping its separate inward-pointing arrow glyphs -
    // the edge lines plus label already communicate the same boundary.
    if (showBandEdges) {
      const spanHz = binWidthHz * binCount;
      const startHz = centerHz - spanHz / 2;
      const endHz = centerHz + spanHz / 2;
      ctx.strokeStyle = "rgba(0,255,0,1.0)";
      ctx.fillStyle = "#00ff00";
      ctx.lineWidth = 1.2;
      ctx.font = `${9 * dpr}px ui-monospace,monospace`;
      for (const band of bandEdgesInSpan(startHz, endHz)) {
        const xLow = pixelForHz(Math.max(band.lowHz, startHz), w, centerHz, binWidthHz, binCount);
        const xHigh = pixelForHz(Math.min(band.highHz, endHz), w, centerHz, binWidthHz, binCount);
        if (xLow !== null) {
          ctx.beginPath();
          ctx.moveTo(xLow, 0);
          ctx.lineTo(xLow, h);
          ctx.stroke();
        }
        if (xHigh !== null && band.highHz <= endHz) {
          ctx.beginPath();
          ctx.moveTo(xHigh, 0);
          ctx.lineTo(xHigh, h);
          ctx.stroke();
        }
        if (xLow !== null && xHigh !== null && xHigh - xLow > 40 * dpr) {
          ctx.fillText(band.label, (xLow + xHigh) / 2 - (band.label.length * 3 * dpr), 12 * dpr);
        }
      }
    }
  }

  return {
    render: (spectrum) => {
      lastSpectrum = spectrum;
      updateAutorange(spectrum.binsDb);
      processFrame(spectrum); // once per real frame only - draw() must never re-run this (see its own call sites)
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
    setWaterfallBias,
    getWaterfallBias: () => waterfallBias,
    setColorIndex,
    getColorIndex: () => colorIndex,
    setFftAveraging,
    getFftAveraging: () => fftAveraging,
    setMaxHoldEnabled,
    isMaxHoldEnabled: () => maxHoldEnabled,
    setHoldDecay,
    getHoldDecay: () => holdDecay,
    setFreezeMinMax,
    isFreezeMinMax: () => freezeMinMax,
    setShowLive,
    isShowLive: () => showLive,
    setShowMaxTrace,
    isShowMaxTrace: () => showMaxTrace,
    setShowMinTrace,
    isShowMinTrace: () => showMinTrace,
    setNoFill,
    isNoFill: () => noFill,
    setHideDcSpike,
    isHideDcSpike: () => hideDcSpike,
    setFrontendFrequencyHz,
    setCursorActive,
    isCursorActive: () => cursorActive,
    setCursorFreqHz,
    getCursorFreqHz: () => cursorFreqHz,
    setShowBandEdges,
    isShowBandEdges: () => showBandEdges,
    canvas,
  };
}

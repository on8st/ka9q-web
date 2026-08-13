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

// Gridline step selection - was "8 equally-spaced PIXELS, label whatever
// frequency happens to land there" (span-derived numbers like 144.393,
// 144.595... - not round). Chooses a "nice" step (1/2/5 x 10^n Hz)
// instead, targeting roughly targetCount gridlines across the current
// span, then gridlines are placed at multiples of THAT step (see
// draw()'s call site) - pixel position follows from the frequency via
// pixelForHz(), not the other way around. One adaptive rule for all
// three receivers rather than per-instance hardcoding: the right step
// depends on what's actually displayed (a whole VHF/UHF band vs. a
// zoomed-in few-kHz HF SSB slice), which changes with zoom regardless
// of which receiver this is - the operator's own stated reasoning for
// why HF specifically needed "something smart" applies identically to
// VHF/UHF at any zoom level other than their typical/default one.
export function niceGridStep(spanHz, targetCount = 6) {
  if (!Number.isFinite(spanHz) || spanHz <= 0 || !Number.isFinite(targetCount) || targetCount <= 0) return 1;
  const rawStep = spanHz / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

// Decimal count follows the step size, not a fixed 3 - a 1 MHz step
// needs none ("144"), a 500 kHz step needs one ("144.5"), a 1 kHz step
// needs three ("14.238", the old default's precision, still correct at
// that scale), and a 100 Hz step (a very tight HF SSB zoom) needs four.
// Always whole multiples of the step, so trailing digits are never
// arbitrary - every displayed label is exactly representable at this
// precision by construction.
export function fmtAxisLabel(hz, stepHz) {
  const stepMHz = stepHz / 1e6;
  const decimals = Math.max(0, Math.ceil(-Math.log10(stepMHz)));
  return (hz / 1e6).toFixed(decimals);
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
// min_db unmodified). RAISING this value raises the effective floor,
// which crushes MORE of the low-end noise to the colormap's darkest
// stop - the opposite of "brighter". Stock's own default is +5; lowered
// after live feedback that the waterfall looked washed out/dim
// throughout (2026-08-11). -10 was tried first and live-verified as a
// large overcorrection (crushed the whole waterfall bright with almost
// no dark background/contrast left) - 0 is a much smaller nudge off
// stock's own default, still adjustable per-user via the waterfall
// context menu's Bias control.
export const WATERFALL_BIAS_DEFAULT = 0;
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
const FFT_AVERAGING_MAX = 50; // matches both entry points' HTML max=50
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

// Autorange, ported from omnisdr's AutoRange (on8st/omnisdr,
// src/shared/db-range.js) - operator-confirmed live to have none of the
// flicker/staleness problems this UI's own continuous per-frame EMA
// caused (three straight follow-up fixes chasing it - see git log for
// fix-2-followup2/3/4 - each one a symptom of the same root cause: the
// displayed range moving a little on literally every frame). Two changes
// from the old design:
//   - the floor tracks a low PERCENTILE of the current bins (robust
//     against a single noise spike pulling the true minimum down),
//     capped to a span between AUTORANGE_MIN_SPAN_DB and
//     AUTORANGE_MAX_SPAN_DB above the floor, rather than the literal
//     min/max of the frame;
//   - the smoothed result only COMMITS - becomes what currentRange()
//     actually returns - once every AUTORANGE_COMMIT_INTERVAL_MS,
//     snapped to a coarse dB grid, instead of drifting every single
//     frame. This is the actual fix: a waterfall row painted under a
//     range that's stable for seconds at a time never needs revisiting
//     later, which is why the offscreen waterfall canvas below needs no
//     recolor-on-drift or periodic-repaint machinery at all - the old
//     design's entire reason for existing goes away with a range that
//     doesn't constantly move.
const AUTORANGE_ALPHA = 0.15;
const AUTORANGE_FLOOR_PCT = 0.25;
const AUTORANGE_MIN_SPAN_DB = 25;
const AUTORANGE_MAX_SPAN_DB = 70;
const AUTORANGE_MARGIN_DB = 6;
const AUTORANGE_COMMIT_INTERVAL_MS = 3000;
const AUTORANGE_SNAP_DB = 2;

function percentileDb(binsDb, p) {
  if (!binsDb || binsDb.length === 0) return 0;
  const sorted = Float32Array.from(binsDb).sort(); // TypedArray sort() is numeric by default
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

export function createSpectrumDisplay(container, { onTune, onPan, onZoom } = {}) {
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
  // Real per-mode filter passband, Hz relative to the carrier (e.g. USB
  // ~+50..+3000, LSB ~-3000..-50, AM/FM/SAM roughly symmetric around 0) -
  // null until the server's first filterEdges echo arrives. Used to make
  // the tuned-frequency highlight band reflect the ACTUAL passband
  // instead of a fixed, always-symmetric width regardless of mode -
  // reported live: switching to USB left the highlight exactly as wide
  // and centred as FM/AM, not offset to one side the way a real USB
  // passband is.
  let filterLowHz = null;
  let filterHighHz = null;
  let manualRange = null; // {minDb, maxDb} once the operator sets one explicitly
  let smoothMinDb = null;
  let smoothMaxDb = null;
  let spectrumPercent = loadSpectrumPercent();
  let waterfallBias = loadWaterfallBias();
  let colorIndex = loadColorIndex();

  // Raw per-row bin data (Float32Array), front = newest, one entry per
  // real frame received. Only used for the RARE bulk-repaint path below
  // (resize, span change, or an explicit color-setting change) - not for
  // per-frame painting any more (see wfCanvas). Capped well above any
  // realistic panel height so memory stays bounded regardless of how
  // tall the waterfall is resized to.
  let waterfallHistory = [];
  const WATERFALL_HISTORY_MAX = 4096;
  let lastSpanKey = null; // `${centerHz}|${binWidthHz}|${binCount}` of the frame history was captured under

  // Waterfall rendering - ported from omnisdr's Pane (on8st/omnisdr,
  // public/pane.js: this.wf/this.wfx), which the operator confirmed live
  // has none of the flicker/rollback/stutter bugs three straight rounds
  // of a putImageData-history-array design produced here (git log
  // fix-2-followup2/3/4 for the full history of what went wrong each
  // time). The core idea: a persistent OFFSCREEN canvas holds the
  // waterfall's pixel history directly - the already-scrolled/painted
  // pixels themselves ARE the history, there's no separate raw-data
  // recolor pass in the common case. draw() only ever READS wfCanvas (a
  // cheap, side-effect-free blit onto the main canvas); every WRITE
  // happens exactly once per real frame, in render() - never in draw() -
  // so there is no way for an unrelated redraw (cursor hover, tuned-freq
  // echo, a trace-visibility toggle, ...) to scroll it, which is what
  // caused the rollback bug. And because AUTORANGE_COMMIT_INTERVAL_MS
  // above means the color range is now stable for seconds at a time
  // instead of drifting every frame, a row painted once rarely needs
  // revisiting - no timer/threshold-based recolor-on-drift machinery is
  // needed at all, which is what caused the flicker/stutter bug.
  const wfCanvas = document.createElement("canvas");
  const wfCtx = wfCanvas.getContext("2d");
  // Set whenever something invalidates already-painted pixels outright:
  // a resize/layout change (wfCanvas gets resized, which clears it - the
  // same "blank, fills back in" behaviour issue 8's fix relied on), a
  // span change (old rows are scoped to a frequency range that no longer
  // applies), or the operator directly changing a color-affecting
  // setting (bias/colormap/manual range) and expecting the WHOLE
  // waterfall to reflect it immediately, not just new rows from now on.
  let wfNeedsRepaint = true; // first draw always does a real paint

  function setSpectrumPercent(pct) {
    spectrumPercent = clampSpectrumPercent(pct);
    localStorage.setItem(SPECTRUM_PERCENT_KEY, String(spectrumPercent));
    if (!paused) draw();
  }

  function setWaterfallBias(bias) {
    waterfallBias = Number(bias);
    if (!Number.isFinite(waterfallBias)) waterfallBias = WATERFALL_BIAS_DEFAULT;
    localStorage.setItem(WATERFALL_BIAS_KEY, String(waterfallBias));
    wfNeedsRepaint = true;
    if (!paused) draw();
  }

  function setColorIndex(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= COLORMAP_NAMES.length) return;
    colorIndex = idx;
    localStorage.setItem(COLORMAP_INDEX_KEY, String(colorIndex));
    wfNeedsRepaint = true;
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

  // CSS-string form for wfCanvas's fillStyle (the per-frame fast path
  // below, ported from omnisdr's Pane#draw, paints via fillRect + a CSS
  // color rather than raw ImageData pixel writes).
  function waterfallColorCss(db, minDb, maxDb) {
    const [r, g, b] = waterfallColor(db, minDb, maxDb);
    return `rgb(${r},${g},${b})`;
  }

  // "FFT averaging amount" - client-side EMA, applied before the trace/
  // waterfall are drawn (both consume the averaged bins, matching stock -
  // see alphaForAveraging()'s header comment for the real-wire-command
  // sibling this is NOT).
  let fftAveraging = loadNumber(FFT_AVERAGING_KEY, 1); // 1 = no smoothing, matches the stock input's min
  let binsAverage = null; // Float32Array, lazily (re)sized to match binCount

  function setFftAveraging(n) {
    // The lower bound was already enforced; the HTML max=50 on both entry
    // points' inputs was advisory only - nothing stopped a value above 50
    // from being accepted and stored as-is (issue 24, confirmed live
    // 2026-08-13). Both bounds enforced here now, the single place this
    // value is ever set from either entry point.
    fftAveraging = Math.min(FFT_AVERAGING_MAX, Math.max(1, Number(n) || 1));
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

  // Left-click-drag pans the view (onPan), a plain left-click (no real
  // movement) tunes or sets the cursor, same as before - distinguished by
  // a small pixel threshold so an intentional pan never gets misread as a
  // tune-to-the-drag-start-point and vice versa. Requested explicitly
  // 2026-08-13 - a prior version of this file's own comment here noted
  // "this UI has no drag-to-pan yet to distinguish from" as the reason
  // click-to-tune could stay this simple; no longer true.
  const PAN_DRAG_THRESHOLD_PX = 4;
  const PAN_SEND_THROTTLE_MS = 60;
  let dragStartX = null;
  let dragLastSentX = null;
  let didPan = false;
  let lastPanSendMs = 0;
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // left button only - right button opens the context menu
    dragStartX = e.clientX;
    dragLastSentX = e.clientX;
    didPan = false;
  });
  window.addEventListener("mousemove", (e) => {
    if (dragStartX === null || !lastSpectrum) return;
    if (!didPan && Math.abs(e.clientX - dragStartX) < PAN_DRAG_THRESHOLD_PX) return;
    didPan = true;
    const now = Date.now();
    if (now - lastPanSendMs < PAN_SEND_THROTTLE_MS) return;
    lastPanSendMs = now;
    const dpr = window.devicePixelRatio || 1;
    const dxDevicePx = (e.clientX - dragLastSentX) * dpr;
    dragLastSentX = e.clientX;
    const spanHz = lastSpectrum.binWidthHz * lastSpectrum.binCount;
    const hzPerDevicePx = spanHz / canvas.width;
    // Dragging right reveals content that was further left - the view
    // centre moves the opposite way from the mouse, same convention as
    // panning a map by dragging it.
    const newCenterHz = lastSpectrum.centerHz - dxDevicePx * hzPerDevicePx;
    if (onPan) onPan(newCenterHz);
  });
  window.addEventListener("mouseup", () => {
    dragStartX = null;
    dragLastSentX = null;
    // didPan is read (and reset) by the "click" handler just below, which
    // always fires right after mouseup for the same press - not reset
    // here, or a real drag's own terminating click would be missed.
  });
  // Click-to-tune (prerequisite for "Keep frequency centred"/AZC, which
  // just conditionally follows this with a zoomCenter). Cursor-active
  // takes priority, matching stock: a click sets the cursor marker
  // instead of tuning when the cursor is turned on. Suppressed entirely
  // if the click is the tail end of a real pan drag (didPan) - otherwise
  // every pan would ALSO retune to wherever the drag happened to end.
  canvas.addEventListener("click", (e) => {
    if (didPan) { didPan = false; return; }
    if (!lastSpectrum) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr;
    const hz = hzForPixel(x, canvas.width, lastSpectrum.centerHz, lastSpectrum.binWidthHz, lastSpectrum.binCount);
    if (cursorActive) setCursorFreqHz(hz);
    else if (onTune) onTune(hz);
  });

  // Mouse wheel over the canvas zooms (in on scroll-up, out on
  // scroll-down) - a separate gesture from the per-digit wheel-to-step
  // tuning in freq-digits.js, requested explicitly 2026-08-13.
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (onZoom) onZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

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

  // rawFloorEma/rawTopEma hold the EMA'd PRE-margin/PRE-snap values so
  // each commit's smoothing step is against the true previous estimate,
  // not the already-padded/snapped display value - otherwise the margin
  // and snap rounding would compound into the EMA on every commit.
  let rawFloorEma = null;
  let rawTopEma = null;
  let lastAutorangeCommitAt = 0;
  // Confirmed live on HF (RX888): the very first real spectrum frame
  // after connecting can be a degenerate, all-equal-value placeholder
  // (every bin at the same dB value) sent briefly before real signal
  // data flows - not something VHF/UHF's front ends do, but real on
  // this one. The very first commit snaps directly to whatever it's
  // given (no EMA blend yet, by design - see below), so a bad seed like
  // that got baked in and then took the normal ~40s+ of slow 15%-per-
  // AUTORANGE_COMMIT_INTERVAL_MS steps to climb out of - the whole
  // trace pinned/clipped at the ceiling that entire time (reported
  // live). Fix: commit FAST (no EMA, no 3s gate) for the first few real
  // frames so a bad seed self-corrects in a couple hundred ms instead,
  // then settle into the slow/smoothed cadence once stabilised.
  const AUTORANGE_WARMUP_COMMITS = 5;
  const AUTORANGE_WARMUP_INTERVAL_MS = 300;
  let autorangeCommitCount = 0;

  function updateAutorange(binsDb) {
    const now = Date.now();
    const warmingUp = autorangeCommitCount < AUTORANGE_WARMUP_COMMITS;
    const interval = warmingUp ? AUTORANGE_WARMUP_INTERVAL_MS : AUTORANGE_COMMIT_INTERVAL_MS;
    if (smoothMinDb !== null && now - lastAutorangeCommitAt < interval) return;
    lastAutorangeCommitAt = now;
    autorangeCommitCount++;

    const floor = percentileDb(binsDb, AUTORANGE_FLOOR_PCT);
    let peak = -Infinity;
    for (let i = 0; i < binsDb.length; i++) if (binsDb[i] > peak) peak = binsDb[i];
    // Top tracks the peak but is capped so a strong signal can't bloom
    // the scale, and is kept at least AUTORANGE_MIN_SPAN_DB above the
    // floor so weak signals stay visible.
    let top = Math.min(peak + 3, floor + AUTORANGE_MAX_SPAN_DB);
    top = Math.max(top, floor + AUTORANGE_MIN_SPAN_DB);

    if (warmingUp) {
      rawFloorEma = floor;
      rawTopEma = top;
    } else {
      rawFloorEma = rawFloorEma === null ? floor : rawFloorEma + AUTORANGE_ALPHA * (floor - rawFloorEma);
      rawTopEma = rawTopEma === null ? top : rawTopEma + AUTORANGE_ALPHA * (top - rawTopEma);
    }

    smoothMinDb = Math.round((rawFloorEma - AUTORANGE_MARGIN_DB) / AUTORANGE_SNAP_DB) * AUTORANGE_SNAP_DB;
    smoothMaxDb = Math.round(rawTopEma / AUTORANGE_SNAP_DB) * AUTORANGE_SNAP_DB;
  }

  function currentRange() {
    if (manualRange) return manualRange;
    if (smoothMinDb === null) return { minDb: -100, maxDb: -20 };
    return { minDb: smoothMinDb, maxDb: smoothMaxDb };
  }

  // Every caller (the ctx-menu's direct Ceiling/Floor number inputs,
  // baselineUp/Down, rangeIncrease/Decrease) funnels through here, so a
  // single guard covers all of them. rangeDecrease() already refuses to
  // shrink the span below 10dB from its own direction; this is the same
  // 10dB floor applied here so an inverted/degenerate range (confirmed
  // live 2026-08-13: typing a Floor value above the current Ceiling, or
  // clicking Floor+ enough times, stuck with no visual recovery short of
  // Autoscale - dbToColor()'s (db-minDb)/(maxDb-minDb) division goes
  // negative/degenerate) can't be reached from any entry point at all.
  function setRangeInternal(minDb, maxDb) {
    if (maxDb - minDb < 10) maxDb = minDb + 10;
    manualRange = { minDb, maxDb };
    wfNeedsRepaint = true;
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

  /** (Re)paints the WHOLE offscreen waterfall canvas from waterfallHistory
   * against the given range - the bulk, occasional path (resize, span
   * change, or an explicit color-setting change), not the per-frame one.
   * Bulk raw-pixel writes (createImageData/putImageData) are the right
   * tool here, unlike for the single-row fast path below - cost is
   * O(width x height), but this only ever runs on a deliberate, rare
   * trigger (wfNeedsRepaint), never per frame. */
  function repaintWaterfallFromHistory(w, wfH, minDb, maxDb) {
    if (w < 1 || wfH < 1) return;
    const img = wfCtx.createImageData(w, wfH);
    for (let rowIdx = 0; rowIdx < wfH; rowIdx++) {
      const rowOffset = rowIdx * w * 4;
      const rowBins = rowIdx < waterfallHistory.length ? waterfallHistory[rowIdx] : null;
      if (rowBins) {
        const rowBinCount = rowBins.length;
        for (let x = 0; x < w; x++) {
          const db = rowBins[binIndexForPixel(x, w, rowBinCount)];
          const [r, g, b] = waterfallColor(db, minDb, maxDb);
          const i = rowOffset + x * 4;
          img.data[i] = r;
          img.data[i + 1] = g;
          img.data[i + 2] = b;
          img.data[i + 3] = 255;
        }
      } else {
        // No history yet for this row (panel taller than what's been
        // captured so far - e.g. right after a resize or fresh page
        // load). putImageData writes alpha literally rather than
        // compositing, so leaving this transparent would reveal
        // whatever's behind the canvas instead of a deliberate blank
        // row - paint the same background colour the trace region uses.
        for (let x = 0; x < w; x++) {
          const i = rowOffset + x * 4;
          img.data[i] = 4; img.data[i + 1] = 6; img.data[i + 2] = 10; img.data[i + 3] = 255;
        }
      }
    }
    wfCtx.putImageData(img, 0, 0);
  }

  /** Ensures wfCanvas matches the panel's current (w, wfH) and is up to
   * date, repainting from history when its size just changed or
   * wfNeedsRepaint was set. Cheap no-op otherwise - safe to call every
   * draw(). */
  function ensureWaterfallCanvas(w, wfH, minDb, maxDb) {
    const sizeChanged = wfCanvas.width !== w || wfCanvas.height !== wfH;
    if (sizeChanged) {
      wfCanvas.width = w; // resizing a canvas clears it - the same
      wfCanvas.height = wfH; // "blank, fills back in" behaviour issue 8 relied on
    }
    if (sizeChanged || wfNeedsRepaint) {
      repaintWaterfallFromHistory(w, wfH, minDb, maxDb);
      wfNeedsRepaint = false;
    }
  }

  /** Scrolls the offscreen waterfall canvas down 1px and paints the
   * newest row on top - the fast, common-case path, ported directly from
   * omnisdr's Pane#draw (public/pane.js): a native canvas self-copy plus
   * one fillRect per column, no ImageData allocation at all. Called
   * exactly once per real frame, from render() - never from draw() - so
   * there is no way for an unrelated redraw to trigger an extra scroll
   * (the root cause of the rollback bug the old design had). */
  function scrollWaterfallAndAppendRow(rowBins, minDb, maxDb) {
    const w = wfCanvas.width, wfH = wfCanvas.height;
    if (w < 1 || wfH < 1) return;
    if (wfH > 1) wfCtx.drawImage(wfCanvas, 0, 1);
    const rowBinCount = rowBins.length;
    for (let x = 0; x < w; x++) {
      const db = rowBins[binIndexForPixel(x, w, rowBinCount)];
      wfCtx.fillStyle = waterfallColorCss(db, minDb, maxDb);
      wfCtx.fillRect(x, 0, 1, 1);
    }
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

    // Only the trace region needs an explicit clear - the waterfall
    // region below it is a straight blit of wfCanvas (see below), which
    // always covers every pixel there.
    ctx.fillStyle = "#04060A";
    ctx.fillRect(0, 0, w, splitY);

    // Waterfall: draw() only ever READS wfCanvas - a cheap, side-effect-
    // free blit. All mutation (scrolling, painting new rows) happens in
    // render(), see scrollWaterfallAndAppendRow()'s own comment for why.
    const wfTop = Math.floor(splitY);
    const wfH = Math.floor(h - splitY);
    if (wfH > 0) {
      ensureWaterfallCanvas(w, wfH, minDb, maxDb);
      ctx.drawImage(wfCanvas, 0, wfTop);
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
        let xLow, xHigh;
        if (filterLowHz !== null && filterHighHz !== null) {
          // Real passband - not necessarily symmetric around the carrier
          // (USB/LSB/CW aren't). Computed directly rather than via
          // pixelForHz(), which returns null outside the displayed span -
          // an edge partially off-screen (e.g. zoomed in tight near one
          // side of the passband) should still show what IS visible,
          // clipped to the canvas, not silently fall back to the fixed-
          // width band below.
          const spanHz = binWidthHz * binCount;
          const startHz = centerHz - spanHz / 2;
          const rawPixelForHz = (hz) => ((hz - startHz) / spanHz) * w;
          xLow = Math.max(0, Math.min(w, rawPixelForHz(tunedFreqHz + filterLowHz)));
          xHigh = Math.max(0, Math.min(w, rawPixelForHz(tunedFreqHz + filterHighHz)));
          if (xLow > xHigh) [xLow, xHigh] = [xHigh, xLow];
        } else {
          // No real filter edges yet (server hasn't echoed any) - fall
          // back to the original fixed-width band rather than showing
          // nothing.
          xLow = x - w * 0.0175;
          xHigh = x + w * 0.0175;
        }
        ctx.fillStyle = "rgba(86,199,255,0.13)";
        ctx.fillRect(xLow, 0, xHigh - xLow, wfTop);
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
    {
      const leftHz = hzForPixel(0, w, centerHz, binWidthHz, binCount);
      const rightHz = hzForPixel(w, w, centerHz, binWidthHz, binCount);
      // targetCount=9: verified against realistic spans before deploying -
      // lands exactly on the operator's own two examples at each band's
      // typical/full-coverage view (VHF ~4.3MHz -> 0.5MHz step, UHF
      // ~8.8MHz -> 1MHz step), and stays sensible (5-9 gridlines) across
      // everything from a full HF band down to a 2.8kHz SSB QSO zoom.
      const step = niceGridStep(rightHz - leftHz, 9);
      const firstTick = Math.ceil(leftHz / step) * step;
      for (let hz = firstTick; hz <= rightHz; hz += step) {
        const x = pixelForHz(hz, w, centerHz, binWidthHz, binCount);
        if (x === null) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, wfTop);
        ctx.stroke();
        ctx.fillText(fmtAxisLabel(hz, step), x - 16 * dpr, wfTop - 4 * dpr);
      }
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
      // Autorange state must not carry over across a real span/context
      // change (zoom, retune, band switch) - the cached floor/ceiling
      // reflect whatever was under the OLD view, not the new one. Left
      // alone, the display sat on stale numbers and only crawled toward
      // the truth via the normal EMA + 3s-commit cadence - about a
      // minute of visibly-stepped, wrong-looking range before it
      // settled (reported live: "starts way too low"). Resetting here,
      // BEFORE updateAutorange() runs for this frame, makes it re-seed
      // directly from fresh data instead (see updateAutorange()'s own
      // "first call" branch) - as fast as the very first page load,
      // which was already instant for the same reason.
      const spanKey = `${spectrum.centerHz}|${spectrum.binWidthHz}|${spectrum.binCount}`;
      if (spanKey !== lastSpanKey) {
        smoothMinDb = null;
        smoothMaxDb = null;
        rawFloorEma = null;
        rawTopEma = null;
        autorangeCommitCount = 0; // every new view gets the fast warm-up treatment, not just page load
      }
      updateAutorange(spectrum.binsDb);
      const rowBins = processFrame(spectrum); // once per real frame only - draw() must never re-run this (see its own call sites)
      // Gated on !paused, matching the pre-existing pause semantics: the
      // waterfall previously only gained a new row as a side effect of
      // draw() actually running (skipped entirely while paused), so
      // paused frames were silently dropped for the waterfall rather than
      // queued up. Pushing unconditionally here would instead accumulate
      // a backlog and dump it all in at once on unpause - a new
      // discontinuity this fix shouldn't introduce.
      if (!paused) {
        // binIndexForPixel() maps a pixel position to a bin index purely
        // by proportion within THAT row's own bin array - it has no idea
        // what frequency any given bin actually represents. A stored row
        // is only valid to redraw at the CURRENT pixel layout if it was
        // captured under the exact same centerHz/binWidthHz/binCount -
        // change any of those (zoom level, re-centering, a retune) and
        // every old row would be redrawn as if it still spanned the new
        // frequency range, showing completely wrong content at wrong
        // positions. Confirmed live: 9 rapid zoom-in clicks turned the
        // waterfall into a garish, meaningless wash - old, differently-
        // scoped rows getting recoloured AND remapped onto a pixel
        // layout they were never captured under. Clear the history
        // outright on any span change instead - a fresh, empty waterfall
        // that fills back in is correct; a full one showing stale,
        // mis-mapped data is not. (spanKey itself is computed once above,
        // before updateAutorange() - the autorange reset there needs the
        // OLD lastSpanKey too, and re-deriving the same string twice per
        // frame would be pointless.)
        if (spanKey !== lastSpanKey) {
          waterfallHistory.length = 0;
          lastSpanKey = spanKey;
          wfNeedsRepaint = true; // old wfCanvas pixels are scoped to the old span - blank it, don't wait for them to scroll out
        }
        waterfallHistory.unshift(Float32Array.from(rowBins));
        if (waterfallHistory.length > WATERFALL_HISTORY_MAX) waterfallHistory.length = WATERFALL_HISTORY_MAX;
        // Paint the new row directly here, once, right where it's known
        // to be genuinely new - not inside draw(), which runs far more
        // often than real frames arrive (cursor hover, tuned-freq echoes,
        // trace-visibility toggles...) and previously had to guess
        // whether a given call represented new data (a fragile sequence-
        // counter check that still got this wrong under some call
        // orderings - see git log fix-2-followup3). Structurally
        // impossible for an unrelated redraw to trigger a scroll now.
        const { minDb, maxDb } = currentRange();
        scrollWaterfallAndAppendRow(rowBins, minDb, maxDb);
        draw();
      }
    },
    resize,
    setRange: setRangeInternal,
    getRange: () => currentRange(),
    clearManualRange: () => { manualRange = null; wfNeedsRepaint = true; },
    setPaused: (v) => { paused = v; },
    isPaused: () => paused,
    setTunedFreqHz: (hz) => { tunedFreqHz = hz; if (!paused) draw(); },
    setFilterEdges: (lowHz, highHz) => {
      filterLowHz = Number.isFinite(lowHz) ? lowHz : null;
      filterHighHz = Number.isFinite(highHz) ? highHz : null;
      if (!paused) draw();
    },
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

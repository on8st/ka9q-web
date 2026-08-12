// "Meter style changes the readout. The choice between a bar and an
// analog meter changes what is shown in the control block itself. A
// settings panel holds the choice, never a second meter." (brief section 4)
//
// IF_POWER's real range isn't a documented protocol fact - -80..0 dB is a
// presentational choice (comfortably spans what's been observed live,
// roughly -37dB on a quiet 2m channel) picked for a readable meter, not
// read from anywhere. Adjust if real-world readings clip against it.
const MIN_DB = -80;
const MAX_DB = 0;
const MIN_NEEDLE_DEG = -60;
const MAX_NEEDLE_DEG = 60;
const STORAGE_KEY = "instrument_meter_style";

export function dbToPercent(db, minDb = MIN_DB, maxDb = MAX_DB) {
  const clamped = Math.min(maxDb, Math.max(minDb, db));
  return ((clamped - minDb) / (maxDb - minDb)) * 100;
}

export function dbToNeedleDeg(db, minDeg = MIN_NEEDLE_DEG, maxDeg = MAX_NEEDLE_DEG) {
  const pct = dbToPercent(db) / 100;
  return minDeg + pct * (maxDeg - minDeg);
}

// "S-meter metric" (stock: the `meter` <select>, Signal/SNR/OVR) - ported
// from html/smeter.js's updateSMeter(). Signal reuses the existing
// ifPowerDb path unchanged; SNR and OVR are new math over fields this UI
// didn't previously decode (ws-client.js's signalMetrics/filterEdges).
export const SNR_MIN_DB = -10;
export const SNR_MAX_DB = 50;

function dbToLinearPower(db) {
  return Math.pow(10, db / 10);
}

/** SNR from baseband (signal+noise) power, noise density, and filter
 * bandwidth - ported exactly from smeter.js: subtracts the noise power
 * out of the signal+noise power before converting back to dB, floors at
 * -100dB (stock's own floor) when the subtraction would go non-positive
 * (i.e. no detectable signal above the noise floor). */
export function computeSnrDb(basebandPowerDb, noiseDensityDb, bandwidthHz) {
  const noisePower = dbToLinearPower(noiseDensityDb) * bandwidthHz;
  const signalPlusNoisePower = dbToLinearPower(basebandPowerDb);
  const ratio = signalPlusNoisePower / noisePower;
  return ratio - 1 > 0 ? 10 * Math.log10(ratio - 1) : -100;
}

/** OVR is NOT a count - it's "how recently did an ADC overrange happen",
 * decaying hyperbolically toward 0 the longer none occurs (1 right after
 * one, 0.1 ten seconds later, etc.), ported exactly from smeter.js.
 * Clamped to [0,1] - stock displays it as a plain 0-100% fill, not dB. */
export function computeOvrRatio(inputSamprate, samplesSinceOver) {
  if (!samplesSinceOver || !inputSamprate) return 0;
  return Math.min(1, Math.max(0, inputSamprate / samplesSinceOver));
}

function percentToNeedleDeg(pct, minDeg = MIN_NEEDLE_DEG, maxDeg = MAX_NEEDLE_DEG) {
  return minDeg + (pct / 100) * (maxDeg - minDeg);
}

// Reuses .minibar/<i> - the only CSS actually defined for a bar meter
// (index.html). This used to generate its own .meter-bar-track/
// .meter-bar-fill markup, but no CSS for those classes was ever written
// (a static, unrelated .minibar element elsewhere in the DOM had the
// real styling, never wired to this module) - the bar rendered with no
// width/height/background at all, effectively invisible, while the
// analog meter's inline SVG attributes made it self-contained and
// unaffected. Reported live as "the non-analog meter doesn't work"
// (2026-08-11).
function renderBar(container, pct) {
  container.innerHTML = `<div class="minibar"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}

function renderAnalog(container, pct) {
  const deg = percentToNeedleDeg(pct).toFixed(1);
  container.innerHTML = `
    <svg class="meter-analog" viewBox="0 0 100 60" width="100" height="60">
      <path d="M 10 55 A 40 40 0 0 1 90 55" fill="none" stroke="#444" stroke-width="2"/>
      <line x1="50" y1="55" x2="50" y2="18" stroke="#f66" stroke-width="2"
            transform="rotate(${deg} 50 55)"/>
      <circle cx="50" cy="55" r="3" fill="#f66"/>
    </svg>`;
}

const METRIC_KEY = "instrument_meter_metric";
export const METRICS = ["signal", "snr", "ovr"];

/** Picks which value to show and maps it to a 0-100% fill, or
 * { valid: false } if the metric's required inputs aren't available yet
 * (e.g. SNR needs filter edges, which may not have arrived - the meter
 * shows a placeholder rather than a wrong/stale reading). */
function percentForMetric(metric, values) {
  if (metric === "snr") {
    const { basebandPowerDb, noiseDensityDb, bandwidthHz } = values;
    if (![basebandPowerDb, noiseDensityDb, bandwidthHz].every(Number.isFinite)) return { valid: false };
    return { valid: true, percent: dbToPercent(computeSnrDb(basebandPowerDb, noiseDensityDb, bandwidthHz), SNR_MIN_DB, SNR_MAX_DB) };
  }
  if (metric === "ovr") {
    const { inputSamprate, samplesSinceOver } = values;
    if (!Number.isFinite(inputSamprate) || !Number.isFinite(samplesSinceOver)) return { valid: false };
    return { valid: true, percent: computeOvrRatio(inputSamprate, samplesSinceOver) * 100 };
  }
  if (!Number.isFinite(values.ifPowerDb)) return { valid: false };
  return { valid: true, percent: dbToPercent(values.ifPowerDb) };
}

/** Manages which meter style AND metric are shown, both persisted across
 * reloads - only one meter, showing one metric, is ever in the DOM at
 * once (brief: "never a second meter"). render() accepts either a plain
 * dB number (shorthand for {ifPowerDb: db}, the pre-existing call shape)
 * or a values object carrying whichever of ifPowerDb/basebandPowerDb/
 * noiseDensityDb/bandwidthHz/inputSamprate/samplesSinceOver the current
 * metric needs. */
// If the selected metric (SNR/OVR) stays invalid this long, fall back to
// "signal" - confirmed live that some stations never populate
// BASEBAND_POWER/NOISE_DENSITY (arrive as zero-length fields, decoding to
// -Infinity dB, permanently failing the finite check) regardless of
// meter style, so a metric choice persisted from an earlier session (or
// a station where it once worked) can leave the meter reading "—"
// forever with no way back to a working state short of clearing
// localStorage. "signal" always has a value once any frontend/spectrum
// data has arrived at all, so it's the one metric always safe to fall
// back to. 5s is long enough to not misfire on a brief startup gap
// (page load, mode/frequency change) before the first real reading
// arrives, short enough that the meter doesn't sit blank for long.
const FALLBACK_METRIC = "signal";
const INVALID_FALLBACK_MS = 5000;

export function createMeter(container) {
  let style = localStorage.getItem(STORAGE_KEY) || "bar";
  let metric = METRICS.includes(localStorage.getItem(METRIC_KEY)) ? localStorage.getItem(METRIC_KEY) : "signal";
  let lastValues = null;
  let invalidSinceMs = null; // when the current metric first went invalid, or null while valid/unknown

  function render(dbOrValues) {
    lastValues = (typeof dbOrValues === "number") ? { ifPowerDb: dbOrValues } : (dbOrValues || {});
    const { valid, percent } = percentForMetric(metric, lastValues);
    if (!valid) {
      container.innerHTML = "—";
      if (metric !== FALLBACK_METRIC) {
        const now = Date.now();
        if (invalidSinceMs === null) invalidSinceMs = now;
        else if (now - invalidSinceMs >= INVALID_FALLBACK_MS) {
          setMetric(FALLBACK_METRIC);
        }
      }
      return;
    }
    invalidSinceMs = null;
    (style === "analog" ? renderAnalog : renderBar)(container, percent);
  }

  function setStyle(newStyle) {
    style = newStyle;
    localStorage.setItem(STORAGE_KEY, style);
    render(lastValues);
  }

  function setMetric(newMetric) {
    if (!METRICS.includes(newMetric)) return;
    metric = newMetric;
    invalidSinceMs = null;
    localStorage.setItem(METRIC_KEY, metric);
    render(lastValues);
  }

  return { render, setStyle, getStyle: () => style, setMetric, getMetric: () => metric };
}

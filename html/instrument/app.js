// Wiring for the instrument UI. Visual structure and interaction pattern
// (segment + anchored popover, single scope canvas, slide-in drawer)
// follow the approved design mockup - see INSTRUMENT-DECISIONS.md for
// what's deliberately NOT wired here (features tests/check-parity.mjs
// still marks instrumentId: null) rather than shown as inert controls.
import { Ka9qWebClient } from "./ws-client.js";
import { createDigitDisplay } from "./freq-digits.js";
import { createValuePanel } from "./value-panel.js";
import { STEP_OPTIONS_HZ, applyStep, fmtStep, snapToStep } from "./tune-step.js";
import { modeForFrequency } from "./mode-by-frequency.js";
import { bandsInCoverage, BAND_OPTIONS } from "./band-options.js";
import { bandForFrequency } from "./band-edges.js";
import { loadMemories, addMemory, deleteMemory, replaceMemories, exportMemoriesJson, importMemoriesJson } from "./memories.js";
import { createMeter } from "./meter.js";
import { createSpectrumDisplay, COLORMAP_NAMES } from "./spectrum-canvas.js";
import { loadNotes, saveNotes } from "./notes.js";
import { spectrumToCsv } from "./spectrum-export.js";
import { createAudioPlayer } from "./audio.js";
import { showContextMenu } from "./context-menu.js";

const $ = (id) => document.getElementById(id);
let currentFreqHz = null;
let stepHz = 1000;
let frontendFrequencyHz = 0; // FIRST_LO_FREQUENCY - the front end's real tuned centre, used for "Hide DC spike"'s bin lookup, not for correcting centerHz (which is already absolute - see PROTOCOL-SPECTRUM.md)
let currentCoverage = { lowHz: 0, highHz: 0 };

const MODES = ["cwu", "cwl", "usb", "lsb", "am", "sam", "fm", "iq", "isb", "user1", "user2", "user3"];

// Single source of truth for setWindow()'s valid values, [wireValue, label]
// pairs. Both the drawer's #window-type select and the spectrum ctx-menu's
// Window select are populated from this array now - previously each
// hand-maintained its own list and the ctx-menu's had silently drifted to
// only 6 of the 9 real options (missing Exact Blackman, Blackman-Harris,
// HP5FT - issue 22, found 2026-08-13). A single array populating both is
// what actually prevents that drift from recurring, not just backfilling
// the missing 3 once.
const WINDOW_TYPES = [
  ["KAISER_WINDOW", "Kaiser"],
  ["RECT_WINDOW", "Rectangular"],
  ["BLACKMAN_WINDOW", "Blackman"],
  ["EXACT_BLACKMAN_WINDOW", "Exact Blackman"],
  ["GAUSSIAN_WINDOW", "Gaussian"],
  ["HANN_WINDOW", "Hann"],
  ["HAMMING_WINDOW", "Hamming"],
  ["BLACKMAN_HARRIS_WINDOW", "Blackman-Harris"],
  ["HP5FT_WINDOW", "HP5FT"],
];

function fmtMHz(hz) {
  if (hz === null || hz === undefined) return "—";
  return (hz / 1e6).toFixed(3);
}

// Whole-MHz range label for the "zoom out to everything" chip (e.g. "0-31MHz"
// for HF's real ~0.015-30.456 MHz coverage) - rounded rather than fmtMHz()'s
// 3-decimal precision, matching the short, glanceable style of the other
// band chips ("20M", "WWV10") instead of a fussy exact-edge readout.
function fmtWholeMHzRange(lowHz, highHz) {
  return `${Math.floor(lowHz / 1e6)}-${Math.ceil(highHz / 1e6)}MHz`;
}

// Per-mode filter edge defaults, ported exactly from stock's
// setFilterEdgesForMode() (html/radio.js) - not invented. Stock only
// pre-fills the two input fields on a mode change, it does NOT auto-send
// them (the operator still has to click Edge/Send) - matched exactly
// here, same reasoning: an unreviewed automatic filter-edge change while
// receiving would be surprising, a pre-filled suggestion is not.
const MODE_FILTER_DEFAULTS = {
  cwu: [-200, 200], cwl: [-200, 200],
  usb: [50, 3000],
  lsb: [-3000, -50],
  am: [-5000, 5000], sam: [-5000, 5000], isb: [-5000, 5000],
  fm: [-6000, 6000],
  iq: [-5000, 5000],
  // user1/2/3: no stock default either - left as-is, matching stock's own switch's default case.
};
function applyFilterDefaultsForMode(mode) {
  const edges = MODE_FILTER_DEFAULTS[(mode || "").toLowerCase()];
  if (!edges) return;
  $("filter-low").value = String(edges[0]);
  $("filter-high").value = String(edges[1]);
}

const client = new Ka9qWebClient(
  (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/",
).connect();

// "Switch modes by frequency" (stock: cksbFrequency - a manifest-name
// misnomer, see mode-by-frequency.js) - applied to programmatic tuning
// (click-to-tune, band select, memory recall), not user-typed entry or
// manual step nudges, matching stock's own "don't override the user"
// guard as closely as this UI's simpler tune() call sites allow. Stock
// persists this ("switchModesByFrequency" in localStorage) - matched here
// too (reported not surviving reload, live, 2026-08-11 - this toggle had
// simply never been wired to storage at all).
const MODE_BY_FREQ_KEY = "instrument_mode_by_freq";
// Default ON, not off - requested explicitly 2026-08-13: "the mode
// selector should default to the mode relevant to that spectrum part."
// An explicit "0" (the operator turned it off) is respected; anything
// else (unset, or "1") is on. Harmless on VHF/UHF either way -
// modeForFrequency() (mode-by-frequency.js) returns null above 30MHz by
// construction, so this never fires there regardless of the setting.
let modeByFreqEnabled = localStorage.getItem(MODE_BY_FREQ_KEY) !== "0";
function setModeByFreqEnabled(v) {
  modeByFreqEnabled = !!v;
  localStorage.setItem(MODE_BY_FREQ_KEY, modeByFreqEnabled ? "1" : "0");
}
function maybeAutoSwitchMode(hz) {
  if (!modeByFreqEnabled) return;
  const mode = modeForFrequency(hz);
  if (mode && mode !== client.mode) {
    client.setMode(mode);
    applyFilterDefaultsForMode(mode);
    // setMode() has no echo (see ws-client.js's own comment: "Mode
    // confirmation is asymmetric with frequency confirmation") - unlike
    // tuneTo()'s optimistic frequency update, nothing else will ever move
    // #tuned-mode off its old value here. Confirmed live 2026-08-13: after
    // an auto-switch the label stayed on the previous mode indefinitely,
    // even though the server-side mode had actually changed - the same
    // optimistic-update fix issue #16 applied to frequency, applied here
    // to mode. Mirrors the manual Mode-picker's own click handler, which
    // already does this.
    $("tuned-mode").textContent = mode;
  }
}

// ---- Spectrum/waterfall: fills #display-area, per "the receiver fills
// the screen" (brief section 4). ----
// "Keep frequency centred" - declared before createSpectrumDisplay since
// its onTune callback closes over it. No stock equivalent to match, but
// persisted for the same reason as modeByFreqEnabled above (reported not
// surviving reload, live, 2026-08-11).
const AZC_ENABLED_KEY = "instrument_azc_enabled";
let azcEnabled = localStorage.getItem(AZC_ENABLED_KEY) === "1";
function setAzcEnabled(v) {
  azcEnabled = !!v;
  localStorage.setItem(AZC_ENABLED_KEY, azcEnabled ? "1" : "0");
}
const spectrumDisplay = createSpectrumDisplay($("display-area"), {
  onTune: (rawHz) => {
    // Click-to-tune lands on the same grid the step buttons walk, not the
    // exact (sub-Hz) pixel clicked.
    const hz = snapToStep(rawHz, stepHz);
    tuneTo(hz);
  },
  // Left-click-drag pan and mouse-wheel zoom, requested explicitly
  // 2026-08-13. spectrum-canvas.js has no access to `client` (kept
  // independent of the wire protocol by design - see ws-client.js's own
  // header comment), so it reports the gesture as a plain Hz/direction
  // value through these callbacks and this is where it actually becomes
  // a wire command, same pattern as onTune above.
  onPan: (centerHz) => client.zoomCenter(centerHz),
  // Wheel zoom-out is capped at the currently tuned ham band's own real
  // width - requested explicitly 2026-08-13 ("should never zoom larger
  // than the selected band"). Same width formula as the band chips' own
  // zoom-to-fit (targetSpanForChip() below: real edges * 1.15 headroom),
  // deliberately not reused wholesale here though - that function's
  // utility/broadcast fallback spans (20kHz/300kHz) are meant for "zoom
  // IN to this chip," not a cap on zooming OUT, and would wrongly
  // restrict wheel-zoom whenever the tuned frequency isn't inside a
  // defined ham band at all (Full Band, WWV, broadcast). The cap only
  // applies when `bandForFrequency()` finds a real match; zooming out
  // stays unrestricted everywhere else, same as before this change.
  onZoom: (direction) => {
    if (currentFreqHz === null) return;
    if (direction < 0) {
      const band = bandForFrequency(currentFreqHz);
      if (band) {
        const maxSpanHz = (band.highHz - band.lowHz) * 1.15;
        const last = spectrumDisplay.getLastSpectrum();
        const currentSpanHz = last ? last.binWidthHz * last.binCount : 0;
        if (currentSpanHz >= maxSpanHz) return; // already at/beyond the band's width
      }
    }
    client.zoomStep(direction, currentFreqHz);
  },
});
// ---- Cursor frequency readout - the cursor marker itself (spectrum-
// canvas.js) was already ported; its numeric readout (stock's
// #cursor_data) wasn't. Shown only while the cursor is actually active
// and has a value, so it doesn't sit there empty for the (default,
// common) case where the cursor feature isn't in use. ----
const cursorReadout = $("cursor-readout");
function updateCursorReadout() {
  const active = spectrumDisplay.isCursorActive();
  const hz = spectrumDisplay.getCursorFreqHz();
  if (active && hz !== null) {
    cursorReadout.textContent = `Cursor ${fmtMHz(hz)} MHz`;
    cursorReadout.classList.add("show");
  } else {
    cursorReadout.classList.remove("show");
  }
}

// ---- Zoom-span transient popup - ported from stock's zoom_bw_popup
// (html/radio.js), simplified to a single reactive trigger: stock shows
// it both from zoomin()/zoomout()'s own optimistic pre-update AND from
// the server's z_level echo; this UI has no local zoom-table copy to
// compute an optimistic span from, so it relies solely on the real
// spectrum frame's own zoomLevel/binWidthHz/binCount - at the default
// 100ms poll rate that's still effectively instant, and it uniformly
// covers every way the zoom level can change (buttons, drawer slider,
// even another client), not just this UI's own buttons. ----
const zoomPopup = $("zoom-popup");
let lastShownZoomLevel = null;
let zoomPopupHideTimer = null;
function noteZoomLevel(detail) {
  if (detail.zoomLevel === lastShownZoomLevel) return;
  lastShownZoomLevel = detail.zoomLevel;
  const spanHz = detail.binWidthHz * detail.binCount;
  const label = spanHz >= 1_000_000 ? `${(spanHz / 1e6).toFixed(2)} MHz` : `${(spanHz / 1e3).toFixed(1)} kHz`;
  zoomPopup.textContent = label;
  zoomPopup.classList.add("show");
  if (zoomPopupHideTimer) clearTimeout(zoomPopupHideTimer);
  zoomPopupHideTimer = setTimeout(() => zoomPopup.classList.remove("show"), 900);
}

client.addEventListener("spectrum", (e) => {
  // centerHz is already absolute RF Hz (sp->center_frequency, server-
  // side - see ka9q-web.c's session-init comment and PROTOCOL-SPECTRUM.md).
  // No FIRST_LO_FREQUENCY addition needed or wanted - stock's own
  // radio.js uses the wire value directly too. A prior version of this
  // line added frontendFrequencyHz on top, based on a since-corrected
  // misreading of the wire format (masked for HF, where the front end's
  // own LO happens to be ~0 - see PROTOCOL-SPECTRUM.md's full account).
  spectrumDisplay.render(e.detail);
  lastInputSamprate = e.detail.inputSamprate;
  renderMeterNow(); // OVR decays moment-to-moment - refresh every frame, not just on frontend/signalMetrics updates
  driveZoomFit(e.detail);
  updateCursorReadout();
  noteZoomLevel(e.detail);
});
client.addEventListener("signalMetrics", () => renderMeterNow());
client.addEventListener("filterEdges", () => renderMeterNow());

// ---- Connection status: reconnect on drop, show a brief indicator.
// Previously both handlers here were literal no-ops - confirmed via
// source read, not something this session assumed: if the WebSocket
// dropped, nothing attempted to reconnect and nothing told the operator
// the display had gone stale. Stock has a full reconnect/busy modal with
// retry/cancel buttons (createReconnectPopup()/createBusyPopup(),
// html/radio.js) - this is a lighter equivalent: automatic reconnect
// with capped exponential backoff, plus a small non-blocking banner
// rather than a modal, since the goal here is "tell the operator and
// keep trying," not "make them click something." ----
const connBanner = $("conn-banner");
let reconnectAttempt = 0;
let reconnectTimer = null;
function showConnBanner(text) {
  connBanner.textContent = text;
  connBanner.classList.add("show");
}
function hideConnBanner() {
  connBanner.classList.remove("show");
}
function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled - don't stack retries
  reconnectAttempt++;
  const delayMs = Math.min(10_000, 1000 * Math.pow(1.6, reconnectAttempt - 1));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    client.connect();
  }, delayMs);
}
client.addEventListener("open", () => {
  reconnectAttempt = 0;
  hideConnBanner();
});
client.addEventListener("close", () => {
  showConnBanner("Connection lost — reconnecting…");
  scheduleReconnect();
});
client.addEventListener("busy", (e) => {
  // BUSY: is a text reply from the server (session-capacity limit), not
  // a socket-level failure - the socket itself may still close right
  // after, which "close"'s own handler will schedule a retry for; this
  // just gives a more specific message while that's pending.
  showConnBanner(`Server busy${e.detail?.reason ? " (" + e.detail.reason + ")" : ""} — retrying…`);
});

// ---- Meter segment ----
const meter = createMeter($("fe-power"));
let lastInputSamprate = null;

// "S-meter metric" (Signal/SNR/OVR) needs several independently-arriving
// pieces (signalMetrics' basebandPowerDb/noiseDensityDb/samplesSinceOver,
// filterEdges' bandwidth, and inputSamprate from the spectrum stream) -
// re-render from whichever arrived most recently each time any one of
// them updates. Signal and SNR both key off basebandPowerDb now (issue
// 5, see meter.js's header comment) - frontend's ifPowerDb (front-end-
// wide IF power, not tied to any specific tuned channel) is no longer
// read here at all.
function renderMeterNow() {
  const sm = client.signalMetrics;
  const edges = client.filterEdges;
  meter.render({
    basebandPowerDb: sm ? sm.basebandPowerDb : null,
    noiseDensityDb: sm ? sm.noiseDensityDb : null,
    bandwidthHz: edges ? Math.abs(edges.highHz - edges.lowHz) : null,
    inputSamprate: lastInputSamprate,
    samplesSinceOver: sm ? sm.samplesSinceOver : null,
  });
}

createValuePanel($("sgm-meter"), (panel, close) => {
  panel.innerHTML = `
    <div class="pop-head"><span>Meter</span><span>reads signal</span></div>
    <div class="pop-body">
      <label class="chk"><input type="checkbox" id="ck-analog" ${meter.getStyle() === "analog" ? "checked" : ""}> Analog meter in the readout</label>
      <div class="chips g4" id="meter-metric-chips">${["signal", "snr", "ovr"].map((m) => `<span class="chip${m === meter.getMetric() ? " on" : ""}" data-metric="${m}">${m.toUpperCase()}</span>`).join("")}</div>
    </div>`;
  panel.querySelector("#ck-analog").addEventListener("change", (e) => {
    meter.setStyle(e.target.checked ? "analog" : "bar");
  });
  panel.addEventListener("click", (e) => {
    const m = e.target.dataset.metric;
    if (!m) return;
    meter.setMetric(m);
    renderMeterNow();
    close();
  });
});

// ---- Audio segment ----
const audioPlayer = createAudioPlayer(client);
let lastVolumeSlider = "1";
let lastPanSlider = "0";

function renderAudioState() {
  $("audio-state").textContent = !audioPlayer.isPlaying() ? "Off" : (audioPlayer.isRecording() ? "Rec" : "On");
}
renderAudioState();

createValuePanel($("sgm-audio"), (panel, close) => {
  panel.innerHTML = `
    <div class="pop-head"><span>Audio</span><span></span></div>
    <div class="pop-body">
      <button class="k" id="audio-toggle">${audioPlayer.isPlaying() ? "Stop audio" : "Start audio"}</button>
      <label class="chk"><input type="checkbox" id="audio-pcm" ${audioPlayer.isPcm() ? "checked" : ""}> PCM (uncheck for Opus)</label>
      <div class="prow"><span class="cap" style="min-width:52px">Volume</span><input type="range" id="audio-volume" min="0" max="1" step="0.01" value="${lastVolumeSlider}" style="flex:1"></div>
      <div class="prow"><span class="cap" style="min-width:52px">Pan</span><input type="range" id="audio-pan" min="-1" max="1" step="0.1" value="${lastPanSlider}" style="flex:1"></div>
      <button class="k mini" id="audio-record" ${audioPlayer.isPlaying() ? "" : "disabled"}>${audioPlayer.isRecording() ? "Stop recording" : "Record"}</button>
    </div>`;
  panel.querySelector("#audio-toggle").addEventListener("click", () => {
    if (audioPlayer.isPlaying()) audioPlayer.stop();
    else audioPlayer.start();
    renderAudioState();
    close();
  });
  panel.querySelector("#audio-pcm").addEventListener("change", (e) => {
    audioPlayer.setPcm(e.target.checked);
  });
  panel.querySelector("#audio-volume").addEventListener("input", (e) => {
    lastVolumeSlider = e.target.value;
    audioPlayer.setVolume(Number(e.target.value));
  });
  panel.querySelector("#audio-pan").addEventListener("input", (e) => {
    lastPanSlider = e.target.value;
    audioPlayer.setPan(Number(e.target.value));
  });
  panel.querySelector("#audio-record").addEventListener("click", () => {
    const freqKhz = currentFreqHz !== null ? currentFreqHz / 1000 : 0;
    audioPlayer.toggleRecording(freqKhz, client.mode || "unknown");
    renderAudioState();
    close();
  });
});

// A "zoom out to everything" option only means something distinct from
// "zoom out to my one band" when the receiver's real coverage spans
// multiple ham bands - true for HF (~30 MHz, 0.015-30.456 MHz here) but
// not VHF/UHF (2m ~4 MHz, 70cm ~8.8 MHz - already effectively one band).
// Threshold, not a front-end name check, so it stays correct if a future
// front end's coverage changes rather than hardcoding "HF" specifically.
const WIDEBAND_COVERAGE_MIN_HZ = 10_000_000;
function isWidebandCoverage() {
  return currentCoverage.highHz - currentCoverage.lowHz > WIDEBAND_COVERAGE_MIN_HZ;
}

// ---- Frontend telemetry -> ident badge, coverage, meter, band chips ----
let hasSetInitialView = false;
client.addEventListener("frontend", (e) => {
  const fe = e.detail;
  frontendFrequencyHz = fe.frequencyHz || 0;
  spectrumDisplay.setFrontendFrequencyHz(frontendFrequencyHz);
  $("ident-fe").textContent = "· " + (fe.descriptionText || "unknown front end");
  currentCoverage = { lowHz: fe.frequencyHz + (fe.ifLowHz ?? 0), highHz: fe.frequencyHz + (fe.ifHighHz ?? 0) };
  renderMeterNow();
  updateSelfEntry(fe);
  renderBandCategories();
  // Default the view to Full Band on open, once, the first time real
  // coverage is known - reported live (2026-08-13) that opening the
  // instrument UI (HF in particular, where "full band" vs. "one specific
  // band" is a meaningful, common distinction) should default to Full
  // Band rather than whatever a reattached session happened to leave it
  // on. Guarded so later "frontend" updates (this fires repeatedly as
  // telemetry streams in) don't keep resetting the view mid-session, and
  // restricted to wideband coverage (HF) - VHF/UHF never had this forced
  // reset before today and shouldn't gain it as a side effect.
  //
  // The 2s delay is a deliberate, confirmed-necessary workaround, not
  // padding: traced live (server-side diagnostic logging, since removed)
  // that the server's own Frontend.min_IF/max_IF - used by
  // frontend_if_bounds() to compute where "the middle of the real
  // coverage" actually is, for the Z:c: zoom-centre command
  // goToFullBand() sends - read as NaN for the first several calls after
  // a session starts, before settling to the real values shortly after.
  // The CLIENT's own "frontend" event already has valid ifLowHz/ifHighHz
  // by then (this handler's own currentCoverage computation is correct
  // immediately), but firing goToFullBand() on that very first event
  // raced the server's internal state and landed during its still-NaN
  // window, silently falling back to a symmetric +/-samprate/2 window
  // centred on 0Hz instead of the real coverage midpoint - reported live
  // as "-32..+32MHz instead of 0..32MHz". A real server-side timing/
  // visibility issue between whatever populates vs. reads Frontend -
  // this is a pragmatic client-side wait for it to settle, not a fix to
  // the underlying race (out of scope for a client-only change).
  if (!hasSetInitialView && currentCoverage.highHz > currentCoverage.lowHz) {
    hasSetInitialView = true;
    if (isWidebandCoverage()) {
      setTimeout(goToFullBand, 2000);
      fetchWwvSolar();
      setInterval(fetchWwvSolar, 60 * 60 * 1000); // matches stock's own refresh interval
    }
  }
});

// ---- Frequency digits + step spinner ----
const digitDisplay = createDigitDisplay($("vfo-digits"), (newHz) => tuneTo(newHz));

// Single choke point for every real frequency change (page load's initial
// server echo, click-to-tune, band select, memory recall, step buttons,
// typed entry) - band label and mode-by-frequency used to only update from
// a couple of the manual-tune call sites, so the BAND segment showed "—"
// forever on a fresh page load and other paths (step buttons, memory
// recall) never triggered mode-by-frequency at all. Reported live
// (2026-08-11).
function applyTunedFreq(hz) {
  currentFreqHz = hz;
  digitDisplay.render(hz);
  spectrumDisplay.setTunedFreqHz(hz);
  const band = bandForFrequency(hz);
  $("v-band").textContent = band ? band.label.toUpperCase() : "FULL BAND";
  maybeAutoSwitchMode(hz);
}

// Sends the tune command AND applies it locally right away (optimistic
// update), rather than only reacting to the server's tunedFreq echo below.
// VHF/UHF each have a private radiod instance and confirm a real tune in
// well under 100ms, so the difference was never visible there - but HF's
// ka9q-web instance is a passive subscriber sharing the real production
// radiod (consumers/ka9q-web-hf/compose.yaml), and a live round-trip
// measurement (headless-Chromium/CDP, capturing the real WS traffic) found
// its BFREQ confirmation can take on the order of 20+ seconds to arrive -
// the frequency digits and BAND label sat on the old value that whole
// time, reported as "tuning doesn't update the display" (issue 16). The
// eventual real tunedFreq event (below) still re-applies the SAME
// function afterward, so it remains authoritative if the confirmed
// frequency ever differs from what was requested (e.g. adopted from
// another client) - this only removes the wait for the common case where
// it doesn't.
function tuneTo(hz) {
  client.tune(hz);
  applyTunedFreq(hz);
  // AZC used to live only in the canvas click-to-tune callback, so
  // memory recall and band-chip tuning never re-centered the way stock's
  // "every frequency change also re-centers when AZC is on" does -
  // confirmed via source read, not directly tested until now. Moved
  // here, the single function every tuning path (digit click/wheel,
  // click-to-tune, memory recall, band chips) already goes through, so
  // it now applies uniformly. Band chips and goToFullBand() already send
  // their own explicit zoomCenter() afterward for unrelated reasons
  // (working around setZoomLevel()'s own re-centre-to-0Hz behavior) - an
  // extra AZC-gated call to the same value there is harmless, not a
  // double-tune.
  if (azcEnabled) client.zoomCenter(hz);
}

client.addEventListener("tunedFreq", (e) => applyTunedFreq(e.detail.hz));

// "Full Band" - widest zoom-table entry (index 0), centred on the
// receiver's actual coverage midpoint. Factored out so it can be reused
// both by the Band popup's "Full" chip and as the default initial view
// (see the "frontend" listener below) - reported live (2026-08-13) that
// opening the instrument UI should default to Full Band, not whatever a
// reattached session happened to leave it on.
//
// tuneTo() alone does NOT move the spectrum window's centre - it only
// retunes the VFO/demod passband (sends F:), a separate concept from the
// wide spectrum view's own centre (server's sp->center_frequency).
// zoomCenter() (Z:c:<khz>) is the actual "move the spectrum view here"
// command - AZC (elsewhere in this file) already relies on exactly this
// distinction, calling zoomCenter() explicitly after tuning rather than
// assuming tuning does it. Missing that call here left setZoomLevel(0)'s
// own default centre (0 Hz, not the coverage midpoint) in place - HF's
// real ~0.015-30.456MHz coverage was displayed as -32..+32MHz around
// that stale 0Hz centre (reported live 2026-08-13, easy to mistake for
// the earlier left/right-swap bug at a glance, but a different mechanism
// entirely - that one was a raw bin-order/decode issue, this is a
// missing re-centre call).
function goToFullBand() {
  client.setZoomLevel(0);
  const center = Math.round((currentCoverage.lowHz + currentCoverage.highHz) / 2);
  tuneTo(center);
  client.zoomCenter(center);
}

// "Zoom to fit" - selecting a specific band chip should narrow the view
// to roughly that band's real width, not leave whatever much-wider span
// was already showing (reported live 2026-08-13, same report as the
// Full-Band-on-open fix above). Zoom levels are discrete indices into
// the server's own zoom_table[] (ws-client.js's setZoomLevel()/
// zoomStep()) - there is no direct "set span to N Hz" command - so this
// works by stepping zoomStep(+1, ...) one level at a time and watching
// each real spectrum frame's own reported span (binWidthHz * binCount)
// until it's at or under the target, the same one-step-per-real-frame
// pacing used elsewhere in this file (e.g. the waterfall's own render
// cadence) rather than flooding the server with commands faster than it
// can reply. driveZoomFit() is called from the main "spectrum" listener
// below, once per real frame.
let zoomFitTarget = null; // { spanHz, stepsLeft } while a fit is in progress
const ZOOM_FIT_MAX_STEPS = 20; // safety cap - a zoom table has a real max index; without this a target narrower than the table's finest step would spin forever

function startZoomFit(spanHz) {
  zoomFitTarget = { spanHz, stepsLeft: ZOOM_FIT_MAX_STEPS };
}

function driveZoomFit(spectrum) {
  if (!zoomFitTarget) return;
  const currentSpanHz = spectrum.binWidthHz * spectrum.binCount;
  if (currentSpanHz <= zoomFitTarget.spanHz || zoomFitTarget.stepsLeft <= 0) {
    zoomFitTarget = null;
    return;
  }
  zoomFitTarget.stepsLeft--;
  client.zoomStep(1, currentFreqHz ?? spectrum.centerHz);
}

// Target span for a band chip's zoom-to-fit: real ham-band edges when the
// chip's frequency falls inside one (band-edges.js's HAM_BAND_EDGES -
// exact, the same table "Show ham band edge markers" already draws from),
// a tight fixed span for a single-carrier utility chip (WWV etc. - there
// is no real "width" to zoom to, just a workable close-in view), or a
// moderate fixed span for a broadcast-band chip (no edges table for
// those yet).
function targetSpanForChip(freqHz, category) {
  const band = bandForFrequency(freqHz);
  if (band) return (band.highHz - band.lowHz) * 1.15; // real edges + a little headroom so they're not flush against the panel edge
  if (category === "utility") return 20_000;
  return 300_000;
}

$("step-value").textContent = fmtStep(stepHz);
$("step-up").addEventListener("click", () => {
  if (currentFreqHz !== null) tuneTo(applyStep(currentFreqHz, stepHz, 1));
});
$("step-down").addEventListener("click", () => {
  if (currentFreqHz !== null) tuneTo(applyStep(currentFreqHz, stepHz, -1));
});
createValuePanel($("step-value"), (panel, close) => {
  panel.innerHTML = `
    <div class="pop-head"><span>Tuning step</span><span></span></div>
    <div class="pop-body">
      <div class="chips g4">${STEP_OPTIONS_HZ.map((s) => `<span class="chip${s === stepHz ? " on" : ""}" data-step="${s}">${fmtStep(s)}</span>`).join("")}</div>
    </div>`;
  panel.addEventListener("click", (e) => {
    const s = e.target.dataset.step;
    if (!s) return;
    stepHz = Number(s);
    $("step-value").textContent = fmtStep(stepHz);
    close();
  });
});

// ---- Mode segment ----
createValuePanel($("sgm-mode"), (panel, close) => {
  panel.innerHTML = `
    <div class="pop-head"><span>Mode</span><span></span></div>
    <div class="pop-body">
      <div class="chips g4">${MODES.map((m) => `<span class="chip${m === client.mode ? " on" : ""}" data-mode="${m}">${m.toUpperCase()}</span>`).join("")}</div>
    </div>`;
  panel.addEventListener("click", (e) => {
    const mode = e.target.dataset.mode;
    if (!mode) return;
    client.setMode(mode);
    applyFilterDefaultsForMode(mode);
    $("tuned-mode").textContent = mode;
    close();
  });
});
client.addEventListener("mode", (e) => { $("tuned-mode").textContent = e.detail.mode; });

// ---- Band segment: category tabs + chips filtered to this receiver's
// real coverage (deliberate adaptation - see band-options.js). ----
let bandCategory = "amateur";

function renderBandCategories() {
  const cats = Object.keys(BAND_OPTIONS).filter((c) => bandsInCoverage(c, currentCoverage.lowHz, currentCoverage.highHz).length > 0);
  if (!cats.includes(bandCategory)) bandCategory = cats[0] || "amateur";
}
renderBandCategories();

createValuePanel($("sgm-band"), (panel, close) => {
  const cats = Object.keys(BAND_OPTIONS).filter((c) => bandsInCoverage(c, currentCoverage.lowHz, currentCoverage.highHz).length > 0);
  const bands = bandsInCoverage(bandCategory, currentCoverage.lowHz, currentCoverage.highHz);
  panel.innerHTML = `
    <div class="pop-head"><span>Band</span><span>coverage ${fmtMHz(currentCoverage.lowHz)}–${fmtMHz(currentCoverage.highHz)} MHz</span></div>
    <div class="pop-body">
      <div class="chips" id="band-cats">
        ${isWidebandCoverage() ? `<span class="chip" data-full="1" title="Zoom out to this receiver's entire coverage">${fmtWholeMHzRange(currentCoverage.lowHz, currentCoverage.highHz)}</span>` : ""}
        ${cats.map((c) => `<span class="chip${c === bandCategory ? " on" : ""}" data-cat="${c}">${c}</span>`).join("")}
      </div>
      <div class="chips g4" id="band-chips">${bands.map((b) => `<span class="chip" data-freq="${b.freq}">${b.label}</span>`).join("")}</div>
    </div>`;
  panel.querySelector("#band-cats").addEventListener("click", (e) => {
    if (e.target.dataset.full) {
      // "Full" isn't a named band - it's a reset-the-view action. BAND
      // segment's "FULL BAND" fallback label (applyTunedFreq(),
      // bandForFrequency() -> null) picks it up immediately via
      // tuneTo()'s optimistic update.
      goToFullBand();
      close();
      return;
    }
    const cat = e.target.dataset.cat;
    if (!cat) return;
    bandCategory = cat;
    close();
    $("sgm-band").click();
  });
  panel.querySelector("#band-chips").addEventListener("click", (e) => {
    const freq = e.target.dataset.freq;
    if (!freq) return;
    const hz = Number(freq);
    // Reset to the widest zoom level first, then narrow back in to fit
    // this band's real width (startZoomFit()/driveZoomFit() above) -
    // guarantees a deterministic result regardless of whatever zoom
    // level was active before picking this chip. zoomStep() only ever
    // narrows, so starting from anywhere already narrower than the
    // target would leave the view too tight instead of fitting the
    // newly-selected band (reported live 2026-08-13: selecting a band
    // left the view "much wider than that" - the old code never
    // adjusted zoom at all, just tuned within whatever span was already
    // showing).
    client.setZoomLevel(0);
    // v-band and mode both come from tuneTo()'s optimistic applyTunedFreq()
    // call now, the same single source of truth the real tunedFreq echo
    // uses - correct for both "2M"/"70CM" (matches the chip's own label)
    // and e.g. a WWV quick-tune (not inside any specific ham band).
    tuneTo(hz);
    // setZoomLevel() alone re-centres to ITS OWN default (0Hz), not this
    // chip's frequency - explicit zoomCenter() needed here for the same
    // reason goToFullBand() needs it (see that function's own comment).
    // The subsequent zoomStep() calls inside driveZoomFit() do re-centre
    // as part of their own normal operation, so this would eventually
    // self-correct either way - but only after the first real frame,
    // which would otherwise show the wrong (0Hz-centred) span briefly.
    client.zoomCenter(hz);
    startZoomFit(targetSpanForChip(hz, bandCategory));
    close();
  });
});

// ---- Memory segment ----
let memories = loadMemories();
$("v-mem").textContent = String(memories.length);

createValuePanel($("sgm-mem"), (panel, close) => {
  panel.innerHTML = `
    <div class="pop-head"><span>Channel memories</span><span>${memories.length}</span></div>
    <div class="pop-body">
      <div class="memlist" id="mem-list">${memories.map((m, i) => `
        <div class="mem" data-recall="${i}"><span class="n">${i + 1}</span><span><span class="f">${fmtMHz(m.freqHz)}</span> <span class="m">${m.label}</span></span><span class="m" data-delete="${i}">✕</span></div>
      `).join("")}</div>
      <div class="prow"><button class="k mini" id="mem-save">Save current frequency</button></div>
      <div class="prow"><button class="k mini" id="mem-export">Export</button><button class="k mini" id="mem-import">Import</button><input type="file" id="mem-import-file" accept="application/json" hidden></div>
    </div>`;
  panel.querySelector("#mem-list").addEventListener("click", (e) => {
    const recall = e.target.closest("[data-recall]");
    const del = e.target.dataset.delete;
    if (del !== undefined) {
      memories = deleteMemory(memories, Number(del));
      $("v-mem").textContent = String(memories.length);
      close();
    } else if (recall) {
      tuneTo(memories[Number(recall.dataset.recall)].freqHz);
      close();
    }
  });
  panel.querySelector("#mem-save").addEventListener("click", () => {
    if (currentFreqHz === null) return;
    memories = addMemory(memories, currentFreqHz);
    $("v-mem").textContent = String(memories.length);
    close();
  });
  panel.querySelector("#mem-export").addEventListener("click", () => {
    const blob = new Blob([exportMemoriesJson(memories)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `instrument_memories_${location.hostname.replace(/:/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const importInput = panel.querySelector("#mem-import-file");
  panel.querySelector("#mem-import").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", () => {
    const file = importInput.files[0];
    if (!file) return;
    file.text().then((text) => {
      const imported = importMemoriesJson(text);
      if (imported === null) { alert("Invalid channel memories file."); return; }
      memories = replaceMemories(imported);
      $("v-mem").textContent = String(memories.length);
      close();
    });
  });
});

// ---- SDR switcher segment: hidden unless there's something to switch to
// (brief section 4: "appears only when there is something to switch to").
// This page already knows its own identity (its own live WS connection),
// so it merges itself into the list rather than expecting instances.json
// to describe the instance serving it (INSTRUMENT-DECISIONS.md). ----
let selfEntry = null;
let siblingList = [];

// Short instance id (matches the mockup's "sdr-hf"/"sdr-vhf" naming) -
// derived from this page's own hostname (sdr-vhf.on8st.be -> sdr-vhf)
// rather than the verbose front-end description, which belongs in the
// #ident badge instead. Falls back to the description for local/dev
// access where the hostname isn't in that form (e.g. "localhost").
function shortInstanceName(fe) {
  const host = location.hostname.split(".")[0];
  return host && host !== "localhost" ? host : (fe.descriptionText || location.hostname);
}

function updateSelfEntry(fe) {
  selfEntry = {
    id: "self",
    name: shortInstanceName(fe),
    lowHz: currentCoverage.lowHz,
    highHz: currentCoverage.highHz,
    url: null,
    isSelf: true,
  };
  renderSwitcherSegment();
}

function renderSwitcherSegment() {
  const all = selfEntry ? [selfEntry, ...siblingList] : siblingList;
  // Lives next to the station/front-end badge (#ident, top-left) rather
  // than its own dock segment - moved at the operator's request, "you
  // already have a source indicator there". #ident stays visible either
  // way (it's always showing real info); .switchable just adds the
  // pointer cursor/hover hint for when there's actually something to
  // switch to. The click handler below is wired unconditionally either
  // way - with only one instance the panel just shows "1 detected... here",
  // which is harmless, not worth gating on a second listener.
  $("ident").classList.toggle("switchable", all.length >= 2);
}

createValuePanel($("ident"), (panel, close) => {
  const all = selfEntry ? [selfEntry, ...siblingList] : siblingList;
  panel.innerHTML = `
    <div class="pop-head"><span>Receivers</span><span>${all.length} detected on this host</span></div>
    <div class="pop-body">
      <div class="memlist">${all.map((i) => `
        <div class="mem${i.isSelf ? " on" : ""}" ${i.url ? `data-url="${i.url}"` : ""}>
          <span class="n">${i.isSelf ? "▸" : ""}</span>
          <span><span class="f">${i.isSelf ? i.name : "sdr-" + i.id}</span><br>${fmtMHz(i.lowHz)}–${fmtMHz(i.highHz)} MHz</span>
          <span class="m">${i.isSelf ? "here" : "↗"}</span>
        </div>`).join("")}</div>
    </div>`;
  panel.addEventListener("click", (e) => {
    const row = e.target.closest("[data-url]");
    if (row) location.href = row.dataset.url;
  });
});

fetch("instances.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => { siblingList = Array.isArray(list) ? list : []; renderSwitcherSegment(); })
  .catch(() => { siblingList = []; renderSwitcherSegment(); });

// ---- Drawer: rare things (telemetry, pause, export, notes) - "out of
// the way and one action from anywhere" (brief section 4). ----
const drawer = $("drawer");
$("rare-things").addEventListener("click", () => {
  drawer.classList.toggle("open");
  if (drawer.classList.contains("open")) renderTelemetry();
});
$("drawer-close").addEventListener("click", () => drawer.classList.remove("open"));

// ---- Zoom + spectrum display size (both live in the drawer - setup-once
// adjustments, not per-tune interaction, per the brief's "rare things"
// philosophy). ----
client.addEventListener("zoomTableSize", (e) => { $("zoom-level").max = String(e.detail.size - 1); });
client.addEventListener("spectrum", (e) => {
  if (document.activeElement !== $("zoom-level")) $("zoom-level").value = String(e.detail.zoomLevel);
});
$("zoom-level").addEventListener("input", (e) => client.setZoomLevel(Number(e.target.value)));
$("zoom-in").addEventListener("click", () => { if (currentFreqHz !== null) client.zoomStep(1, currentFreqHz); });
$("zoom-out").addEventListener("click", () => { if (currentFreqHz !== null) client.zoomStep(-1, currentFreqHz); });
$("zoom-center").addEventListener("click", () => { if (currentFreqHz !== null) client.zoomCenter(currentFreqHz); });
$("spectrum-size-up").addEventListener("click", () => spectrumDisplay.incrementSpectrumPercent());
$("spectrum-size-down").addEventListener("click", () => spectrumDisplay.decrementSpectrumPercent());
$("range-autoscale").addEventListener("click", () => spectrumDisplay.forceAutoscale());
$("baseline-up").addEventListener("click", () => spectrumDisplay.baselineUp());
$("baseline-down").addEventListener("click", () => spectrumDisplay.baselineDown());
$("range-inc").addEventListener("click", () => spectrumDisplay.rangeIncrease());
$("range-dec").addEventListener("click", () => spectrumDisplay.rangeDecrease());

$("colormap-select").innerHTML = COLORMAP_NAMES.map((name, i) => `<option value="${i}">${name}</option>`).join("");
$("colormap-select").value = String(spectrumDisplay.getColorIndex());
$("colormap-select").addEventListener("change", (e) => spectrumDisplay.setColorIndex(Number(e.target.value)));
$("waterfall-bias").value = String(spectrumDisplay.getWaterfallBias());
$("waterfall-bias").addEventListener("change", (e) => spectrumDisplay.setWaterfallBias(e.target.value));

// ---- FFT & hold: trace averaging (client-only) + server-side FFT
// averaging/window/overlap/poll rate (real wire commands) + max/min hold
// (client-only trace overlays). ----
$("fft-avg").value = String(spectrumDisplay.getFftAveraging());
$("fft-avg").addEventListener("change", (e) => {
  spectrumDisplay.setFftAveraging(e.target.value);
  // setFftAveraging() clamps both bounds internally (issue 24) - echo the
  // clamped value back so the field doesn't keep showing an out-of-range
  // number that was silently not what actually took effect.
  e.target.value = String(spectrumDisplay.getFftAveraging());
});

// Server-side FFT averaging and overlap are pure fire-and-forget wire
// commands - unlike everything spectrumDisplay tracks, there's no server
// echo to read the real current value back from (same protocol asymmetry
// as setMode(), see issue 20). Without tracking the last value WE sent,
// the ctx-menu's Spectrum/Overlap rows had nothing real to show and fell
// back to hardcoded literals (10, 50%) that never reflected actual state
// (issue 21, found live 2026-08-13). Tracked here, not in
// spectrum-canvas.js, since these two settings don't feed any rendering -
// they're pure "what did I last tell the server" bookkeeping, same
// pattern as quickBwPreset just below.
const SPECTRUM_AVG_KEY = "instrument_spectrum_avg";
const SPECTRUM_OVERLAP_KEY = "instrument_spectrum_overlap";
let lastSpectrumAvg = Number(localStorage.getItem(SPECTRUM_AVG_KEY));
if (!Number.isFinite(lastSpectrumAvg) || lastSpectrumAvg <= 0) lastSpectrumAvg = 10;
let lastOverlap = Number(localStorage.getItem(SPECTRUM_OVERLAP_KEY));
if (!Number.isFinite(lastOverlap) || lastOverlap < 0 || lastOverlap >= 1) lastOverlap = 0.5;
function setLastSpectrumAvg(n) { lastSpectrumAvg = n; localStorage.setItem(SPECTRUM_AVG_KEY, String(n)); }
function setLastOverlap(n) { lastOverlap = n; localStorage.setItem(SPECTRUM_OVERLAP_KEY, String(n)); }

$("spectrum-avg").value = String(lastSpectrumAvg);
$("spectrum-avg-send").addEventListener("click", () => {
  const v = Number($("spectrum-avg").value);
  if (Number.isFinite(v) && v > 0) { client.setSpectrumAverage(v); setLastSpectrumAvg(v); }
});
$("max-hold-enable").checked = spectrumDisplay.isMaxHoldEnabled();
$("max-hold-enable").addEventListener("change", (e) => spectrumDisplay.setMaxHoldEnabled(e.target.checked));
$("show-live").checked = spectrumDisplay.isShowLive();
$("show-live").addEventListener("change", (e) => spectrumDisplay.setShowLive(e.target.checked));
$("show-max").checked = spectrumDisplay.isShowMaxTrace();
$("show-max").addEventListener("change", (e) => spectrumDisplay.setShowMaxTrace(e.target.checked));
$("show-min").checked = spectrumDisplay.isShowMinTrace();
$("show-min").addEventListener("change", (e) => spectrumDisplay.setShowMinTrace(e.target.checked));
$("freeze-min-max").checked = spectrumDisplay.isFreezeMinMax();
$("freeze-min-max").addEventListener("change", (e) => spectrumDisplay.setFreezeMinMax(e.target.checked));
$("hold-decay").value = String(spectrumDisplay.getHoldDecay());
$("hold-decay").addEventListener("change", (e) => spectrumDisplay.setHoldDecay(e.target.value));
$("window-type").innerHTML = WINDOW_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
$("window-send").addEventListener("click", () => {
  const type = $("window-type").value;
  // window-param's HTML says min=0 max=15, but nothing enforced that
  // beyond the browser's advisory-only number-input attributes - a value
  // outside that range was sent to the server as-is (issue 24, confirmed
  // live 2026-08-13). Clamped here and echoed back into the field so the
  // operator sees what was actually applied, not left believing an
  // out-of-range value they typed took effect unmodified.
  const paramRaw = Number($("window-param").value);
  const param = Number.isFinite(paramRaw) ? Math.min(15, Math.max(0, paramRaw)) : 0;
  $("window-param").value = String(param);
  client.setWindow(type, param);
});
$("spectrum-overlap").value = String(lastOverlap);
$("spectrum-overlap-send").addEventListener("click", () => {
  const v = Number($("spectrum-overlap").value);
  if (Number.isFinite(v) && v >= 0 && v < 1) { client.setSpectrumOverlap(v); setLastOverlap(v); }
});
$("spectrum-poll-send").addEventListener("click", () => {
  const v = Number($("spectrum-poll").value);
  if (!Number.isFinite(v) || v <= 0) return;
  // HTML says min=30 max=2000, but that was advisory only - a value
  // outside that range was sent to the server as-is with no client-side
  // guard at all (issue 24, confirmed live 2026-08-13: both 10ms and
  // 5000ms went straight out on the wire unmodified). Clamped and echoed
  // back into the field, same as fft-avg and window-param above.
  const clamped = Math.min(2000, Math.max(30, v));
  $("spectrum-poll").value = String(clamped);
  client.setSpectrumPollRate(clamped);
});

// ---- Cursor, spectrum fill style, hide DC spike ----
$("cursor-active").checked = spectrumDisplay.isCursorActive();
$("cursor-active").addEventListener("change", (e) => spectrumDisplay.setCursorActive(e.target.checked));
$("no-spectrum-fill").checked = spectrumDisplay.isNoFill();
$("no-spectrum-fill").addEventListener("change", (e) => spectrumDisplay.setNoFill(e.target.checked));
$("hide-dc-spike").checked = spectrumDisplay.isHideDcSpike();
$("hide-dc-spike").addEventListener("change", (e) => spectrumDisplay.setHideDcSpike(e.target.checked));

// ---- Reset this UI's own settings (scoped to instrument_* keys - shares
// localStorage with the stock page on the same origin, so a blanket
// localStorage.clear() would also wipe stock's settings; ported intent
// (full local reset), narrowed scope (see INSTRUMENT-DECISIONS.md)). ----
$("reset-settings").addEventListener("click", () => {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("instrument_")) localStorage.removeItem(key);
  }
  location.reload();
});

// ---- Filter edges, CW shift, QuickBW, AZC ----
// Server echoes (filterEdges/shift events) arrive periodically,
// independent of what the user is doing - same race this session already
// found and fixed once for the frequency digits. A plain focus check
// isn't quite enough here though: filter edges are TWO separate inputs
// that both need editing before Send is clicked, so a field can be
// blurred-but-not-yet-sent (e.g. tabbing from Low to High) when an echo
// arrives - confirmed live, a fill-low/fill-high/click-Send sequence
// with no pause still lost the Low value to a mid-sequence echo despite
// the focus guard. Stock hit this same problem (`edgeManualDirty`,
// html/radio.js) and solved it the same way: a dirty flag per field,
// cleared only on Send, not just on blur.
let filterLowDirty = false;
let filterHighDirty = false;
$("filter-low").addEventListener("input", () => { filterLowDirty = true; });
$("filter-high").addEventListener("input", () => { filterHighDirty = true; });
$("filter-edges-send").addEventListener("click", () => {
  const low = Number($("filter-low").value);
  const high = Number($("filter-high").value);
  if (Number.isFinite(low) && Number.isFinite(high)) client.setFilterEdges(low, high);
  filterLowDirty = false;
  filterHighDirty = false;
});
client.addEventListener("filterEdges", (e) => {
  if (!filterLowDirty) $("filter-low").value = String(e.detail.lowHz);
  if (!filterHighDirty) $("filter-high").value = String(e.detail.highHz);
  spectrumDisplay.setFilterEdges(e.detail.lowHz, e.detail.highHz);
});
let shiftDirty = false;
$("shift-input").addEventListener("input", () => { shiftDirty = true; });
$("shift-send").addEventListener("click", () => {
  const v = Number($("shift-input").value);
  if (Number.isFinite(v)) client.setShift(v);
  shiftDirty = false;
});
client.addEventListener("shift", (e) => {
  if (!shiftDirty) $("shift-input").value = String(e.detail.hz);
});

// QuickBW: a filter-edges shortcut, not a distinct wire feature - toggles
// between the current edges and a saved alternate (narrower) preset,
// reusing setFilterEdges() exactly like stock's applyQuickBW().
const QUICKBW_KEY = "instrument_quickbw_preset";
function loadQuickBwPreset() {
  try {
    const raw = JSON.parse(localStorage.getItem(QUICKBW_KEY));
    if (raw && Number.isFinite(raw.lowerOffset) && Number.isFinite(raw.upperOffset)) return raw;
  } catch (e) { /* ignore */ }
  return { lowerOffset: 300, upperOffset: 700 };
}
let quickBwPreset = loadQuickBwPreset();
$("quickbw-lower").value = String(quickBwPreset.lowerOffset);
$("quickbw-upper").value = String(quickBwPreset.upperOffset);
let quickBwActive = false;
let quickBwPrevEdges = null;
$("quickbw-toggle").addEventListener("click", () => {
  if (!quickBwActive) {
    quickBwPrevEdges = { low: $("filter-low").value, high: $("filter-high").value };
    client.setFilterEdges(-quickBwPreset.lowerOffset, quickBwPreset.upperOffset);
  } else if (quickBwPrevEdges) {
    client.setFilterEdges(Number(quickBwPrevEdges.low), Number(quickBwPrevEdges.high));
  }
  quickBwActive = !quickBwActive;
});
$("quickbw-save").addEventListener("click", () => {
  const lowerOffset = Number($("quickbw-lower").value);
  const upperOffset = Number($("quickbw-upper").value);
  if (!Number.isFinite(lowerOffset) || !Number.isFinite(upperOffset)) return;
  quickBwPreset = { lowerOffset, upperOffset };
  localStorage.setItem(QUICKBW_KEY, JSON.stringify(quickBwPreset));
  if (quickBwActive) client.setFilterEdges(-lowerOffset, upperOffset);
});

$("azc-enable").checked = azcEnabled;
$("mode-by-freq").checked = modeByFreqEnabled;
$("azc-enable").addEventListener("change", (e) => { setAzcEnabled(e.target.checked); });
$("mode-by-freq").addEventListener("change", (e) => { setModeByFreqEnabled(e.target.checked); });
$("show-band-edges").checked = spectrumDisplay.isShowBandEdges();
$("show-band-edges").addEventListener("change", (e) => spectrumDisplay.setShowBandEdges(e.target.checked));

function renderTelemetry() {
  const s = spectrumDisplay.getLastSpectrum();
  $("tele").innerHTML = (s ? `
    <div><span>Sample rate</span><span>${(s.inputSamprate / 1e6).toFixed(3)} Ms/s</span></div>
    <div><span>Noise BW</span><span>${s.noiseBwHz.toFixed(1)} Hz</span></div>
    <div><span>RF gain</span><span>${s.rfGainDb.toFixed(1)} dB</span></div>
    <div><span>RF atten</span><span>${s.rfAttenDb.toFixed(1)} dB</span></div>
    <div><span>ADC overs</span><span>${s.adOver}</span></div>
    <div><span>Zoom level</span><span>${s.zoomLevel}</span></div>
  ` : `<div><span>Telemetry</span><span>not yet received</span></div>`)
    + (buildCommit ? `<div><span>Build</span><span>${buildCommit.slice(0, 8)}</span></div>` : "")
    + (wwvSolarText ? `<div><span>WWV solar</span><span>${wwvSolarText}</span></div>` : "");
}

// ---- Build/version info - the drawer had no way to tell which build is
// actually running, unlike stock's #version block (backed by real git
// macros the Makefile already generates, GIT_VERSION etc. - see
// Makefile). Those macros aren't exposed over the wire or any HTTP
// endpoint (confirmed via grep - ka9q-web.c only ever printfs/syslogs
// them), so rather than add a new server endpoint for this, the Docker
// build writes the same commit hash it already captures for
// /etc/ka9q-web-commit into a small static JSON file under
// html/instrument/ too (see images/ka9q-web/Dockerfile) - the Makefile's
// install rule (`cp -r html/.`) picks it up automatically, no server
// change needed. Fetched once; a 404 (older image predating this) is
// swallowed, the row just doesn't appear rather than showing an error.
let buildCommit = null;
fetch("build-info.json").then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (d && d.commit) { buildCommit = d.commit; renderTelemetry(); }
}).catch(() => {});

// ---- WWV solar data - HF-only (gated the same way the Full Band chip
// is: isWidebandCoverage(), not a front-end name check), ported from
// stock's fetchAndDisplayWWVSolarData() including its regexes and hourly
// refresh interval - swpc.noaa.gov sets Access-Control-Allow-Origin: *
// (confirmed live), so this works as a direct browser fetch exactly like
// stock's does, no proxy needed. ----
const WWV_URL = "https://services.swpc.noaa.gov/text/wwv.txt";
let wwvSolarText = null;
function fetchWwvSolar() {
  fetch(WWV_URL).then((r) => r.text()).then((text) => {
    const flux = text.match(/Solar flux (\d+)/)?.[1] ?? "N/A";
    const a = text.match(/A-index (\d+)/)?.[1] ?? "N/A";
    const k = text.match(/K-index.*?was ([\d.]+)/)?.[1] ?? "N/A";
    wwvSolarText = `Flux ${flux} · A ${a} · K ${k}`;
    renderTelemetry();
  }).catch(() => {
    wwvSolarText = "unavailable";
    renderTelemetry();
  });
}

$("pause-toggle").addEventListener("change", (e) => spectrumDisplay.setPaused(e.target.checked));

// ---- Keyboard: Space toggles audio start/stop, matching stock's own
// binding exactly (html/radio.js's global keydown handler) - requested
// explicitly 2026-08-13, replacing an earlier Tier 2 choice that bound
// Space to spectrum pause/resume instead (stock only does that
// specifically in fullscreen mode, which this UI doesn't have). Guarded
// against text-input focus, same as stock's own guard, so typing a
// space into Notes/filter-edges/etc. doesn't toggle audio as a side
// effect. Same start/stop logic as the Audio popover's own button. ----
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (typing) return;
  e.preventDefault();
  if (audioPlayer.isPlaying()) audioPlayer.stop();
  else audioPlayer.start();
  renderAudioState();
});
function exportSpectrumCsv() {
  const current = spectrumDisplay.getLastSpectrum();
  if (!current) return;
  const blob = new Blob([spectrumToCsv(current, current.centerHz)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "spectrum.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}
$("export-csv").addEventListener("click", exportSpectrumCsv);
$("notes-text").value = loadNotes();
$("notes-text").addEventListener("input", (e) => saveNotes(e.target.value));

// ---- Right-click context menu on the spectrum/waterfall canvas - the
// mockup's own two-menu pattern (above the split = Spectrum, below =
// Waterfall), deferred until now since almost every control it hosts
// didn't exist yet when first asked about (see INSTRUMENT-DECISIONS.md).
// Every item here is wired to a function this session already built and
// verified elsewhere (the drawer cards) - this menu is a second, faster
// way to reach the same state, not new functionality of its own. Reads
// current values fresh on each open (`buildContent` re-runs every time),
// so it never goes stale relative to changes made via the drawer.
function ctxRow(labelHtml, controlHtml) {
  return `<div class="ctx-row">${labelHtml}${controlHtml}</div>`;
}
function ctxChk(label, checked, action) {
  return `<label class="chk ctx-row" data-action="${action}"><input type="checkbox" ${checked ? "checked" : ""}><span class="lab">${label}</span></label>`;
}
function ctxAct(label, action) {
  return `<button class="k mini" data-action="${action}" style="width:100%;text-align:left">${label}</button>`;
}
function ctxNum(label, action, value, step = "1") {
  return ctxRow(`<span class="lab">${label}</span>`, `<input class="k num" type="number" step="${step}" value="${value ?? ""}" data-action="${action}">`);
}
// options: either plain strings (value === display text, existing
// callers - Decay, Palette) or [value, label] pairs (Window, where the
// wire value "KAISER_WINDOW" and the display label "Kaiser" differ).
function ctxSel(label, action, options, value) {
  return ctxRow(`<span class="lab">${label}</span>`, `<select class="k" data-action="${action}">${options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return `<option value="${v}"${v === value ? " selected" : ""}>${l}</option>`;
  }).join("")}</select>`);
}
function ctxRange(label, action, min, max, step, value) {
  return ctxRow(`<span class="lab">${label}</span>`, `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-action="${action}">`);
}

function buildSpectrumCtxMenu(panel, close) {
  const range = spectrumDisplay.getRange();
  panel.innerHTML = `
    <div class="pop-head"><span>Spectrum</span><span></span></div>
    <div class="pop-body">
      ${ctxAct("Autoscale", "autoscale")}
      ${ctxChk("Pause", spectrumDisplay.isPaused(), "pause")}
      <div class="sep" style="height:1px;background:rgba(120,135,154,.18)"></div>
      ${ctxNum("Ceiling (dBm)", "ceiling", range.maxDb.toFixed(0))}
      ${ctxNum("Floor (dBm)", "floor", range.minDb.toFixed(0))}
      ${ctxRange("Height", "height", 10, 90, 1, spectrumDisplay.getSpectrumPercent())}
      <div class="grp">Traces</div>
      ${ctxChk("Live", spectrumDisplay.isShowLive(), "live")}
      ${ctxChk("Max", spectrumDisplay.isShowMaxTrace(), "show-max")}
      ${ctxChk("Min", spectrumDisplay.isShowMinTrace(), "show-min")}
      ${ctxChk("Freeze", spectrumDisplay.isFreezeMinMax(), "freeze")}
      ${ctxChk("Max hold", spectrumDisplay.isMaxHoldEnabled(), "max-hold")}
      ${ctxSel("Decay", "decay", ["1", "1.0001", "1.0005", "1.001", "1.005", "1.01", "1.05", "1.1"], String(spectrumDisplay.getHoldDecay()))}
      <div class="grp">Averaging</div>
      ${ctxNum("FFT (client)", "fft-avg", spectrumDisplay.getFftAveraging())}
      ${ctxNum("Spectrum", "spectrum-avg", lastSpectrumAvg)}
      ${ctxSel("Window", "window", WINDOW_TYPES, "KAISER_WINDOW")}
      ${ctxNum("Overlap", "overlap", lastOverlap, "0.01")}
      <div class="sep" style="height:1px;background:rgba(120,135,154,.18)"></div>
      ${ctxChk("Show band edges", spectrumDisplay.isShowBandEdges(), "band-edges")}
      ${ctxChk("No fill", spectrumDisplay.isNoFill(), "no-fill")}
      ${ctxChk("Cursor", spectrumDisplay.isCursorActive(), "cursor")}
      ${ctxAct("Export spectrum (CSV)", "export-csv")}
    </div>`;

  panel.querySelectorAll("[data-action]").forEach((el) => {
    const action = el.dataset.action;
    const eventName = el.tagName === "INPUT" && el.type === "checkbox" ? "change"
      : el.tagName === "INPUT" || el.tagName === "SELECT" ? "change" : "click";
    el.addEventListener(eventName, (e) => {
      const checked = e.target.type === "checkbox" ? e.target.checked : null;
      const val = e.target.value;
      switch (action) {
        case "autoscale": spectrumDisplay.forceAutoscale(); close(); break;
        case "pause": spectrumDisplay.setPaused(checked); break;
        case "live": spectrumDisplay.setShowLive(checked); break;
        // A cleared number input reaches here as val="" (the browser itself
        // sanitizes non-numeric text typed into a type=number field to "",
        // it never reaches JS as the literal typed text) - and Number("")
        // is 0, NOT NaN, so a plain Number.isFinite() check doesn't catch
        // it. Without the explicit val!=="" check, clearing the field
        // silently sent a 0dBm bound with no warning (confirmed live
        // 2026-08-13).
        case "ceiling": { const n = Number(val); if (val !== "" && Number.isFinite(n)) { const r = spectrumDisplay.getRange(); spectrumDisplay.setRange(r.minDb, n); } break; }
        case "floor": { const n = Number(val); if (val !== "" && Number.isFinite(n)) { const r = spectrumDisplay.getRange(); spectrumDisplay.setRange(n, r.maxDb); } break; }
        case "height": spectrumDisplay.setSpectrumPercent(Number(val)); break;
        case "show-max": spectrumDisplay.setShowMaxTrace(checked); break;
        case "show-min": spectrumDisplay.setShowMinTrace(checked); break;
        case "freeze": spectrumDisplay.setFreezeMinMax(checked); break;
        case "max-hold": spectrumDisplay.setMaxHoldEnabled(checked); break;
        case "decay": spectrumDisplay.setHoldDecay(val); break;
        case "fft-avg": spectrumDisplay.setFftAveraging(val); e.target.value = String(spectrumDisplay.getFftAveraging()); break;
        case "spectrum-avg": { const n = Number(val); if (Number.isFinite(n) && n > 0) { client.setSpectrumAverage(n); setLastSpectrumAvg(n); } break; }
        // val is now the full wire value directly (e.g. "KAISER_WINDOW") -
        // WINDOW_TYPES' [value,label] pairs are used as the <option>'s
        // value attribute, matching the drawer's own select exactly, so
        // no more string-concatenation reconstruction needed here.
        case "window": client.setWindow(val, 0); break;
        // Raw 0-0.99 fraction now, same as the drawer's Overlap field and
        // the same units setSpectrumOverlap() itself takes - was 0-100%
        // (val/100) here only, a same-feature/different-units mismatch
        // between the two entry points (issue 23, found live 2026-08-13).
        case "overlap": { const n = Number(val); if (Number.isFinite(n) && n >= 0 && n < 1) { client.setSpectrumOverlap(n); setLastOverlap(n); } break; }
        case "band-edges": spectrumDisplay.setShowBandEdges(checked); break;
        case "no-fill": spectrumDisplay.setNoFill(checked); break;
        case "cursor": spectrumDisplay.setCursorActive(checked); break;
        case "export-csv": exportSpectrumCsv(); close(); break;
      }
    });
  });
}

function buildWaterfallCtxMenu(panel, close) {
  const range = spectrumDisplay.getRange();
  panel.innerHTML = `
    <div class="pop-head"><span>Waterfall</span><span></span></div>
    <div class="pop-body">
      ${ctxNum("Ceiling (dBm)", "wf-ceiling", range.maxDb.toFixed(0))}
      ${ctxNum("Floor (dBm)", "wf-floor", range.minDb.toFixed(0))}
      ${ctxNum("Bias", "bias", spectrumDisplay.getWaterfallBias())}
      <div class="grp">Colormap</div>
      ${ctxSel("Palette", "colormap", COLORMAP_NAMES, COLORMAP_NAMES[spectrumDisplay.getColorIndex()])}
      <div class="sep" style="height:1px;background:rgba(120,135,154,.18)"></div>
      ${ctxAct("Zoom in", "zoom-in")}
      ${ctxAct("Zoom out", "zoom-out")}
      ${ctxAct("Centre on tuned frequency", "zoom-center")}
      ${ctxChk("Auto zoom centre (AZC)", azcEnabled, "azc")}
    </div>`;

  panel.querySelectorAll("[data-action]").forEach((el) => {
    const action = el.dataset.action;
    const eventName = el.type === "checkbox" ? "change" : "change";
    el.addEventListener(eventName, (e) => {
      const checked = e.target.type === "checkbox" ? e.target.checked : null;
      const val = e.target.value;
      switch (action) {
        // Same empty-field guard as the spectrum menu's ceiling/floor -
        // see that case block's comment.
        case "wf-ceiling": { const n = Number(val); if (val !== "" && Number.isFinite(n)) { const r = spectrumDisplay.getRange(); spectrumDisplay.setRange(r.minDb, n); } break; }
        case "wf-floor": { const n = Number(val); if (val !== "" && Number.isFinite(n)) { const r = spectrumDisplay.getRange(); spectrumDisplay.setRange(n, r.maxDb); } break; }
        case "bias": spectrumDisplay.setWaterfallBias(val); break;
        case "colormap": spectrumDisplay.setColorIndex(COLORMAP_NAMES.indexOf(val)); break;
        case "azc": setAzcEnabled(checked); $("azc-enable").checked = checked; break;
      }
    });
  });
  panel.querySelectorAll('[data-action="zoom-in"],[data-action="zoom-out"],[data-action="zoom-center"]').forEach((el) => {
    el.addEventListener("click", () => {
      if (currentFreqHz === null) return;
      if (el.dataset.action === "zoom-in") client.zoomStep(1, currentFreqHz);
      else if (el.dataset.action === "zoom-out") client.zoomStep(-1, currentFreqHz);
      else client.zoomCenter(currentFreqHz);
      close();
    });
  });
}

spectrumDisplay.canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const rect = spectrumDisplay.canvas.getBoundingClientRect();
  const relY = (e.clientY - rect.top) / rect.height;
  if (relY < 0.46) showContextMenu(e.clientX, e.clientY, buildSpectrumCtxMenu);
  else showContextMenu(e.clientX, e.clientY, buildWaterfallCtxMenu);
});

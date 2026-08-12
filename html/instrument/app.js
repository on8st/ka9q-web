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

function fmtMHz(hz) {
  if (hz === null || hz === undefined) return "—";
  return (hz / 1e6).toFixed(3);
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
let modeByFreqEnabled = localStorage.getItem(MODE_BY_FREQ_KEY) === "1";
function setModeByFreqEnabled(v) {
  modeByFreqEnabled = !!v;
  localStorage.setItem(MODE_BY_FREQ_KEY, modeByFreqEnabled ? "1" : "0");
}
function maybeAutoSwitchMode(hz) {
  if (!modeByFreqEnabled) return;
  const mode = modeForFrequency(hz);
  if (mode && mode !== client.mode) client.setMode(mode);
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
    client.tune(hz);
    if (azcEnabled) client.zoomCenter(hz);
    maybeAutoSwitchMode(hz);
  },
});
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
});
client.addEventListener("signalMetrics", () => renderMeterNow());
client.addEventListener("filterEdges", () => renderMeterNow());

client.addEventListener("open", () => {});
client.addEventListener("close", () => {});

// ---- Meter segment ----
const meter = createMeter($("fe-power"));
let lastInputSamprate = null;

// "S-meter metric" (Signal/SNR/OVR) needs several independently-arriving
// pieces (frontend's ifPowerDb, signalMetrics' basebandPowerDb/
// noiseDensityDb/samplesSinceOver, filterEdges' bandwidth, and
// inputSamprate from the spectrum stream) - re-render from whichever
// arrived most recently each time any one of them updates.
function renderMeterNow() {
  const fe = client.frontend;
  const sm = client.signalMetrics;
  const edges = client.filterEdges;
  meter.render({
    ifPowerDb: fe ? fe.ifPowerDb : null,
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

// ---- Frontend telemetry -> ident badge, coverage, meter, band chips ----
client.addEventListener("frontend", (e) => {
  const fe = e.detail;
  frontendFrequencyHz = fe.frequencyHz || 0;
  spectrumDisplay.setFrontendFrequencyHz(frontendFrequencyHz);
  $("ident-fe").textContent = "· " + (fe.descriptionText || "unknown front end");
  currentCoverage = { lowHz: fe.frequencyHz + (fe.ifLowHz ?? 0), highHz: fe.frequencyHz + (fe.ifHighHz ?? 0) };
  renderMeterNow();
  updateSelfEntry(fe);
  renderBandCategories();
});

// ---- Frequency digits + step spinner ----
const digitDisplay = createDigitDisplay($("vfo-digits"), (newHz) => client.tune(newHz));

client.addEventListener("tunedFreq", (e) => {
  const { hz } = e.detail;
  currentFreqHz = hz;
  digitDisplay.render(hz);
  spectrumDisplay.setTunedFreqHz(hz);
  // Single choke point for every real frequency change (page load's
  // initial server echo, click-to-tune, band select, memory recall, step
  // buttons, typed entry) - band label and mode-by-frequency used to only
  // update from a couple of the manual-tune call sites, so the BAND
  // segment showed "—" forever on a fresh page load and other paths
  // (step buttons, memory recall) never triggered mode-by-frequency at
  // all. Reported live (2026-08-11).
  const band = bandForFrequency(hz);
  $("v-band").textContent = band ? band.label.toUpperCase() : "FULL BAND";
  maybeAutoSwitchMode(hz);
});

$("step-value").textContent = fmtStep(stepHz);
$("step-up").addEventListener("click", () => {
  if (currentFreqHz !== null) client.tune(applyStep(currentFreqHz, stepHz, 1));
});
$("step-down").addEventListener("click", () => {
  if (currentFreqHz !== null) client.tune(applyStep(currentFreqHz, stepHz, -1));
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
        <span class="chip" data-full="1" title="Zoom out to this receiver's entire coverage">Full</span>
        ${cats.map((c) => `<span class="chip${c === bandCategory ? " on" : ""}" data-cat="${c}">${c}</span>`).join("")}
      </div>
      <div class="chips g4" id="band-chips">${bands.map((b) => `<span class="chip" data-freq="${b.freq}">${b.label}</span>`).join("")}</div>
    </div>`;
  panel.querySelector("#band-cats").addEventListener("click", (e) => {
    if (e.target.dataset.full) {
      // "Full" isn't a named band - it's a reset-the-view action: widest
      // zoom-table entry (index 0, same convention as the drawer's zoom
      // slider) centred on the receiver's actual coverage midpoint. That
      // midpoint deliberately isn't inside any HAM_BAND_EDGES entry for a
      // wideband front end (HF), so the BAND segment's existing "FULL
      // BAND" fallback label (tunedFreq handler, bandForFrequency() ->
      // null) picks it up for free once the server echoes the retune.
      client.setZoomLevel(0);
      const center = Math.round((currentCoverage.lowHz + currentCoverage.highHz) / 2);
      client.tune(center);
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
    // v-band is NOT set here - the central tunedFreq handler (below)
    // recomputes it from the confirmed frequency once the server echoes
    // it back, which is the single source of truth. Setting it here too
    // would show this chip's own label only to have it immediately
    // overwritten - fine for "2M"/"70CM" where the two agree, but wrong
    // for e.g. a WWV quick-tune, which isn't inside any specific ham band.
    client.tune(Number(freq));
    maybeAutoSwitchMode(Number(freq));
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
      client.tune(memories[Number(recall.dataset.recall)].freqHz);
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
$("fft-avg").addEventListener("change", (e) => spectrumDisplay.setFftAveraging(e.target.value));
$("spectrum-avg-send").addEventListener("click", () => {
  const v = Number($("spectrum-avg").value);
  if (Number.isFinite(v) && v > 0) client.setSpectrumAverage(v);
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
$("window-send").addEventListener("click", () => {
  const type = $("window-type").value;
  const param = $("window-param").value;
  client.setWindow(type, param || 0);
});
$("spectrum-overlap-send").addEventListener("click", () => {
  const v = Number($("spectrum-overlap").value);
  if (Number.isFinite(v) && v >= 0 && v < 1) client.setSpectrumOverlap(v);
});
$("spectrum-poll-send").addEventListener("click", () => {
  const v = Number($("spectrum-poll").value);
  if (Number.isFinite(v) && v > 0) client.setSpectrumPollRate(v);
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
  $("tele").innerHTML = s ? `
    <div><span>Sample rate</span><span>${(s.inputSamprate / 1e6).toFixed(3)} Ms/s</span></div>
    <div><span>Noise BW</span><span>${s.noiseBwHz.toFixed(1)} Hz</span></div>
    <div><span>RF gain</span><span>${s.rfGainDb.toFixed(1)} dB</span></div>
    <div><span>RF atten</span><span>${s.rfAttenDb.toFixed(1)} dB</span></div>
    <div><span>ADC overs</span><span>${s.adOver}</span></div>
    <div><span>Zoom level</span><span>${s.zoomLevel}</span></div>
  ` : `<div><span>Telemetry</span><span>not yet received</span></div>`;
}

$("pause-toggle").addEventListener("change", (e) => spectrumDisplay.setPaused(e.target.checked));
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
function ctxSel(label, action, options, value) {
  return ctxRow(`<span class="lab">${label}</span>`, `<select class="k" data-action="${action}">${options.map((o) => `<option${o === value ? " selected" : ""}>${o}</option>`).join("")}</select>`);
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
      ${ctxRow('<span class="lab">Spectrum</span>', '<input class="k num" type="number" step="1" value="10" data-action="spectrum-avg">')}
      ${ctxSel("Window", "window", ["KAISER", "RECT", "BLACKMAN", "GAUSSIAN", "HANN", "HAMMING"], "KAISER")}
      ${ctxRow('<span class="lab">Overlap (%)</span>', '<input class="k num" type="number" step="1" value="50" data-action="overlap">')}
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
        case "ceiling": { const r = spectrumDisplay.getRange(); spectrumDisplay.setRange(r.minDb, Number(val)); break; }
        case "floor": { const r = spectrumDisplay.getRange(); spectrumDisplay.setRange(Number(val), r.maxDb); break; }
        case "height": spectrumDisplay.setSpectrumPercent(Number(val)); break;
        case "show-max": spectrumDisplay.setShowMaxTrace(checked); break;
        case "show-min": spectrumDisplay.setShowMinTrace(checked); break;
        case "freeze": spectrumDisplay.setFreezeMinMax(checked); break;
        case "max-hold": spectrumDisplay.setMaxHoldEnabled(checked); break;
        case "decay": spectrumDisplay.setHoldDecay(val); break;
        case "fft-avg": spectrumDisplay.setFftAveraging(val); break;
        case "spectrum-avg": { const n = Number(val); if (Number.isFinite(n) && n > 0) client.setSpectrumAverage(n); break; }
        case "window": client.setWindow(`${val}_WINDOW`, 0); break;
        case "overlap": { const n = Number(val) / 100; if (Number.isFinite(n) && n >= 0 && n < 1) client.setSpectrumOverlap(n); break; }
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
        case "wf-ceiling": { const r = spectrumDisplay.getRange(); spectrumDisplay.setRange(r.minDb, Number(val)); break; }
        case "wf-floor": { const r = spectrumDisplay.getRange(); spectrumDisplay.setRange(Number(val), r.maxDb); break; }
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

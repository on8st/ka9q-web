// Wiring for the instrument UI. Visual structure and interaction pattern
// (segment + anchored popover, single scope canvas, slide-in drawer)
// follow the approved design mockup - see INSTRUMENT-DECISIONS.md for
// what's deliberately NOT wired here (features tests/check-parity.mjs
// still marks instrumentId: null) rather than shown as inert controls.
import { Ka9qWebClient } from "./ws-client.js";
import { createDigitDisplay } from "./freq-digits.js";
import { createValuePanel } from "./value-panel.js";
import { STEP_OPTIONS_HZ, applyStep, fmtStep, ALT_STEP_HZ, roundToNearestKhz } from "./tune-step.js";
import { modeForFrequency } from "./mode-by-frequency.js";
import { bandsInCoverage, BAND_OPTIONS } from "./band-options.js";
import { loadMemories, addMemory, deleteMemory, replaceMemories, exportMemoriesJson, importMemoriesJson } from "./memories.js";
import { createMeter } from "./meter.js";
import { createSpectrumDisplay, COLORMAP_NAMES } from "./spectrum-canvas.js";
import { loadNotes, saveNotes } from "./notes.js";
import { spectrumToCsv } from "./spectrum-export.js";
import { createAudioPlayer } from "./audio.js";

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
// guard as closely as this UI's simpler tune() call sites allow.
let modeByFreqEnabled = false;
function maybeAutoSwitchMode(hz) {
  if (!modeByFreqEnabled) return;
  const mode = modeForFrequency(hz);
  if (mode && mode !== client.mode) client.setMode(mode);
}

// "Alternate frequency buttons" (stock: alternate_freq_buttons - another
// manifest-name misnomer, see tune-step.js) - declared early since both
// the digit display's typed-entry commit and the step buttons below
// reference it. No persistence in stock either, resets every reload.
// Simplified: applies the round-to-nearest-kHz to both typed entry and
// digit-click nudges alike (stock only rounds typed "Set" entry) - a
// single onStep callback handles both paths in this UI's freq-digits.js,
// and splitting them for this rarely-used toggle wasn't worth a new API.
let altStepEnabled = false;

// ---- Spectrum/waterfall: fills #display-area, per "the receiver fills
// the screen" (brief section 4). ----
let azcEnabled = false; // "Keep frequency centred" - declared before
// createSpectrumDisplay since its onTune callback closes over it.
const spectrumDisplay = createSpectrumDisplay($("display-area"), {
  onTune: (hz) => {
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
const digitDisplay = createDigitDisplay($("vfo-digits"), (newHz) => client.tune(altStepEnabled ? roundToNearestKhz(newHz) : newHz));

client.addEventListener("tunedFreq", (e) => {
  const { hz } = e.detail;
  currentFreqHz = hz;
  digitDisplay.render(hz);
  spectrumDisplay.setTunedFreqHz(hz);
});

$("step-value").textContent = fmtStep(stepHz);
$("alt-step").addEventListener("click", () => {
  altStepEnabled = !altStepEnabled;
  $("alt-step").classList.toggle("on", altStepEnabled);
});
$("step-up").addEventListener("click", () => {
  if (currentFreqHz !== null) client.tune(applyStep(currentFreqHz, altStepEnabled ? ALT_STEP_HZ : stepHz, 1));
});
$("step-down").addEventListener("click", () => {
  if (currentFreqHz !== null) client.tune(applyStep(currentFreqHz, altStepEnabled ? ALT_STEP_HZ : stepHz, -1));
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
      <div class="chips" id="band-cats">${cats.map((c) => `<span class="chip${c === bandCategory ? " on" : ""}" data-cat="${c}">${c}</span>`).join("")}</div>
      <div class="chips g4" id="band-chips">${bands.map((b) => `<span class="chip" data-freq="${b.freq}">${b.label}</span>`).join("")}</div>
    </div>`;
  panel.querySelector("#band-cats").addEventListener("click", (e) => {
    const cat = e.target.dataset.cat;
    if (!cat) return;
    bandCategory = cat;
    close();
    $("sgm-band").click();
  });
  panel.querySelector("#band-chips").addEventListener("click", (e) => {
    const freq = e.target.dataset.freq;
    if (!freq) return;
    $("v-band").textContent = e.target.textContent;
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
  $("sgm-sdr").hidden = all.length < 2;
  if (all.length >= 2) $("v-sdr").textContent = selfEntry ? selfEntry.name : "";
}

createValuePanel($("sgm-sdr"), (panel, close) => {
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
$("show-live").addEventListener("change", (e) => spectrumDisplay.setShowLive(e.target.checked));
$("show-max").addEventListener("change", (e) => spectrumDisplay.setShowMaxTrace(e.target.checked));
$("show-min").addEventListener("change", (e) => spectrumDisplay.setShowMinTrace(e.target.checked));
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
$("cursor-active").addEventListener("change", (e) => spectrumDisplay.setCursorActive(e.target.checked));
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

$("azc-enable").addEventListener("change", (e) => { azcEnabled = e.target.checked; });
$("mode-by-freq").addEventListener("change", (e) => { modeByFreqEnabled = e.target.checked; });
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
$("export-csv").addEventListener("click", () => {
  const current = spectrumDisplay.getLastSpectrum();
  if (!current) return;
  const blob = new Blob([spectrumToCsv(current, current.centerHz)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "spectrum.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("notes-text").value = loadNotes();
$("notes-text").addEventListener("input", (e) => saveNotes(e.target.value));

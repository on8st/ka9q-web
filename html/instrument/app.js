// Wiring for the instrument UI. Visual structure and interaction pattern
// (segment + anchored popover, single scope canvas, slide-in drawer)
// follow the approved design mockup - see INSTRUMENT-DECISIONS.md for
// what's deliberately NOT wired here (features tests/check-parity.mjs
// still marks instrumentId: null) rather than shown as inert controls.
import { Ka9qWebClient } from "./ws-client.js";
import { createDigitDisplay } from "./freq-digits.js";
import { createValuePanel } from "./value-panel.js";
import { STEP_OPTIONS_HZ, applyStep, fmtStep } from "./tune-step.js";
import { bandsInCoverage, BAND_OPTIONS } from "./band-options.js";
import { loadMemories, addMemory, deleteMemory } from "./memories.js";
import { createMeter } from "./meter.js";
import { createSpectrumDisplay, COLORMAP_NAMES } from "./spectrum-canvas.js";
import { absoluteCenterHz } from "./spectrum-decode.js";
import { loadNotes, saveNotes } from "./notes.js";
import { spectrumToCsv } from "./spectrum-export.js";
import { createAudioPlayer } from "./audio.js";

const $ = (id) => document.getElementById(id);
let currentFreqHz = null;
let stepHz = 1000;
let frontendFrequencyHz = 0; // FIRST_LO_FREQUENCY, needed to make spectrum's baseband-relative centerHz absolute (PROTOCOL-SPECTRUM.md)
let currentCoverage = { lowHz: 0, highHz: 0 };

const MODES = ["cwu", "cwl", "usb", "lsb", "am", "sam", "fm", "iq", "isb", "user1", "user2", "user3"];

function fmtMHz(hz) {
  if (hz === null || hz === undefined) return "—";
  return (hz / 1e6).toFixed(3);
}

const client = new Ka9qWebClient(
  (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/",
).connect();

// ---- Spectrum/waterfall: fills #display-area, per "the receiver fills
// the screen" (brief section 4). ----
const spectrumDisplay = createSpectrumDisplay($("display-area"));
client.addEventListener("spectrum", (e) => {
  const abs = absoluteCenterHz(e.detail, frontendFrequencyHz);
  spectrumDisplay.render({ ...e.detail, centerHz: abs });
});

client.addEventListener("open", () => {});
client.addEventListener("close", () => {});

// ---- Meter segment ----
const meter = createMeter($("fe-power"));
createValuePanel($("sgm-meter"), (panel, close) => {
  panel.innerHTML = `
    <div class="pop-head"><span>Meter</span><span>reads signal</span></div>
    <div class="pop-body">
      <label class="chk"><input type="checkbox" id="ck-analog" ${meter.getStyle() === "analog" ? "checked" : ""}> Analog meter in the readout</label>
    </div>`;
  panel.querySelector("#ck-analog").addEventListener("change", (e) => {
    meter.setStyle(e.target.checked ? "analog" : "bar");
  });
});

// ---- Audio segment ----
const audioPlayer = createAudioPlayer(client);
let lastVolumeSlider = "1";

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
  $("ident-fe").textContent = "· " + (fe.descriptionText || "unknown front end");
  currentCoverage = { lowHz: fe.frequencyHz + (fe.ifLowHz ?? 0), highHz: fe.frequencyHz + (fe.ifHighHz ?? 0) };
  meter.render(fe.ifPowerDb);
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

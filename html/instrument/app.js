// Live status + tuning for this instrument-UI instance. Still minimal:
// proves the real data pipeline and the brief's "tuning happens on the
// digits" behaviour end-to-end, before richer interaction (per-value
// panels, spectrum/waterfall display) gets built on top of it.
import { Ka9qWebClient } from "./ws-client.js";
import { createDigitDisplay } from "./freq-digits.js";
import { createValuePanel } from "./value-panel.js";
import { STEP_OPTIONS_HZ, applyStep, fmtStep } from "./tune-step.js";
import { bandsInCoverage } from "./band-options.js";
import { loadMemories, addMemory, deleteMemory } from "./memories.js";
import { createMeter } from "./meter.js";

const $ = (id) => document.getElementById(id);
let currentFreqHz = null;
let stepHz = 1000;

// Confirmed against the stock UI's own mode <select> (html/radio.html) -
// wusb/wlsb are commented out there too, so left out here as well.
const MODES = ["cwu", "cwl", "usb", "lsb", "am", "sam", "fm", "iq", "isb", "user1", "user2", "user3"];

function fmtMHz(hz) {
  if (hz === null || hz === undefined) return "—";
  return (hz / 1e6).toFixed(3);
}

const client = new Ka9qWebClient(
  (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/",
).connect();

// "Tuning happens on the digits": clicking a digit's upper/lower half
// steps that place value and sends a real tune command immediately.
// Deliberately doesn't optimistically update its own display - it waits
// for the server's own tunedFreq echo, same "server state is
// authoritative" posture ka9q-web.c itself takes (see PROTOCOL-TEXT.md).
// A genuine change always triggers that echo; only a no-op step wouldn't,
// and a no-op step needs no visual update anyway.
const digitDisplay = createDigitDisplay($("vfo-digits"), (newHz) => client.tune(newHz));

client.addEventListener("open", () => { $("conn-state").textContent = "connected"; });
client.addEventListener("close", () => { $("conn-state").textContent = "disconnected"; });

const meter = createMeter($("fe-power"));

client.addEventListener("frontend", (e) => {
  const fe = e.detail;
  $("fe-desc").textContent = fe.descriptionText || "(unknown front end)";
  const lowHz = fe.frequencyHz + (fe.ifLowHz ?? 0);
  const highHz = fe.frequencyHz + (fe.ifHighHz ?? 0);
  $("fe-coverage").textContent = `${fmtMHz(lowHz)}–${fmtMHz(highHz)} MHz`;
  meter.render(fe.ifPowerDb);
  updateSelfEntry(fe);
  renderBandChips(lowHz, highHz);
});

// "A settings panel holds the choice, never a second meter."
createValuePanel($("meter-settings"), (panel, close) => {
  panel.innerHTML = `<button type="button" data-style="bar">Bar</button><button type="button" data-style="analog">Analog</button>`;
  panel.addEventListener("click", (e) => {
    const style = e.target.dataset.style;
    if (!style) return;
    meter.setStyle(style);
    close();
  });
});

// Band quick-select: only bands this receiver can actually reach (see
// band-options.js - not a stock behaviour, a deliberate adaptation since
// each instrument covers one slice of spectrum, unlike the stock all-in-
// one UI). Re-rendered whenever coverage is known (every "frontend" event).
function renderBandChips(lowHz, highHz) {
  const bands = bandsInCoverage("amateur", lowHz, highHz);
  $("band-chips").innerHTML = bands
    .map((b) => `<button type="button" data-freq="${b.freq}">${b.label}</button>`)
    .join("");
}
$("band-chips").addEventListener("click", (e) => {
  const freq = e.target.dataset.freq;
  if (freq) client.tune(Number(freq));
});

// ---- Memories: save/recall, not the stock UI's full 50-slot system (see
// memories.js) - functional intent, not a port. ----
let memories = loadMemories();

function renderMemories() {
  $("memory-chips").innerHTML = memories.map((m, i) => `
    <span class="memory-chip">
      <button type="button" data-recall="${i}">${m.label}</button>
      <button type="button" data-delete="${i}" title="Delete" class="memory-delete">×</button>
    </span>`).join("");
}
renderMemories();

$("memory-chips").addEventListener("click", (e) => {
  const recallIdx = e.target.dataset.recall;
  const deleteIdx = e.target.dataset.delete;
  if (recallIdx !== undefined) {
    client.tune(memories[Number(recallIdx)].freqHz);
  } else if (deleteIdx !== undefined) {
    memories = deleteMemory(memories, Number(deleteIdx));
    renderMemories();
  }
});

$("memory-save").addEventListener("click", () => {
  if (currentFreqHz === null) return;
  memories = addMemory(memories, currentFreqHz);
  renderMemories();
});

client.addEventListener("tunedFreq", (e) => {
  const { hz } = e.detail;
  currentFreqHz = hz;
  $("tuned-freq").textContent = `${fmtMHz(hz)} MHz`;
  $("tune-input").value = (hz / 1000).toFixed(3);
  digitDisplay.render(hz);
});

// "The step is visible, not hidden... tuning by the amount shown."
$("step-value").textContent = fmtStep(stepHz);
$("step-up").addEventListener("click", () => {
  if (currentFreqHz !== null) client.tune(applyStep(currentFreqHz, stepHz, 1));
});
$("step-down").addEventListener("click", () => {
  if (currentFreqHz !== null) client.tune(applyStep(currentFreqHz, stepHz, -1));
});
// "Choosing a different step happens on the step itself."
createValuePanel($("step-value"), (panel, close) => {
  panel.innerHTML = STEP_OPTIONS_HZ.map((s) => `<button type="button" data-step="${s}">${fmtStep(s)}</button>`).join("");
  panel.addEventListener("click", (e) => {
    const s = e.target.dataset.step;
    if (!s) return;
    stepHz = Number(s);
    $("step-value").textContent = fmtStep(stepHz);
    close();
  });
});

client.addEventListener("mode", (e) => {
  $("tuned-mode").textContent = e.detail.mode;
});

// "The readout is the control surface": clicking the mode value opens its
// own picker anchored to it. Mode-setting has no reliable success echo
// (see PROTOCOL-TEXT.md "Mode confirmation is asymmetric with frequency
// confirmation") - ACK is the only confirmation a command reached the
// server at all, so this updates its own display optimistically on
// selection rather than waiting for a "mode" event that a clean success
// will never produce. A genuine M_FORCE (drift correction) still updates
// it authoritatively via the listener above.
createValuePanel($("tuned-mode"), (panel, close) => {
  panel.innerHTML = MODES.map((m) => `<button type="button" data-mode="${m}">${m.toUpperCase()}</button>`).join("");
  panel.addEventListener("click", (e) => {
    const mode = e.target.dataset.mode;
    if (!mode) return;
    client.setMode(mode);
    $("tuned-mode").textContent = mode;
    close();
  });
});

client.addEventListener("busy", (e) => {
  $("status-line").textContent = `Server busy: ${e.detail.reason}`;
});

$("tune-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const khz = parseFloat($("tune-input").value);
  if (Number.isFinite(khz)) client.tune(khz * 1000);
});

// ---- Sibling switcher: merge this instance's own live state with
// instances.json's report of its siblings (see INSTRUMENT-DECISIONS.md -
// an instance can never successfully query its own coverage via
// discovery, since its own server isn't listening yet when discovery
// runs; the page itself already knows exactly who it is). ----
let selfEntry = null;
let siblingList = [];

function updateSelfEntry(fe) {
  selfEntry = {
    id: "self",
    name: fe.descriptionText || location.hostname,
    fe: fe.descriptionText,
    lowHz: fe.frequencyHz + (fe.ifLowHz ?? 0),
    highHz: fe.frequencyHz + (fe.ifHighHz ?? 0),
    url: null,
    isSelf: true,
  };
  renderSwitcher();
}

function renderSwitcher() {
  const all = selfEntry ? [selfEntry, ...siblingList] : siblingList;
  if (all.length < 2) { $("switcher").hidden = true; return; }
  $("switcher").hidden = false;
  $("switcher-list").innerHTML = all.map((i) => {
    const label = `${i.name} (${fmtMHz(i.lowHz)}–${fmtMHz(i.highHz)} MHz)`;
    return i.isSelf || !i.url
      ? `<li>${label}${i.isSelf ? " — here" : ""}</li>`
      : `<li><a href="${i.url}">${label}</a></li>`;
  }).join("");
}

fetch("instances.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => { siblingList = Array.isArray(list) ? list : []; renderSwitcher(); })
  .catch(() => { siblingList = []; renderSwitcher(); });

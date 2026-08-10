// Live status + basic tuning for this instrument-UI instance. Minimal by
// design: proves the real data pipeline (both wire protocols, decoded and
// verified against real traffic - see PROTOCOL-TEXT.md and
// tests/js/ws-client.test.mjs) end-to-end, before any of the design
// brief's richer interaction (click-to-tune digits, per-value panels,
// spectrum/waterfall display) gets built on top of it.
import { Ka9qWebClient } from "./ws-client.js";

const $ = (id) => document.getElementById(id);

function fmtMHz(hz) {
  if (hz === null || hz === undefined) return "—";
  return (hz / 1e6).toFixed(3);
}

const client = new Ka9qWebClient(
  (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/",
).connect();

client.addEventListener("open", () => { $("conn-state").textContent = "connected"; });
client.addEventListener("close", () => { $("conn-state").textContent = "disconnected"; });

client.addEventListener("frontend", (e) => {
  const fe = e.detail;
  $("fe-desc").textContent = fe.descriptionText || "(unknown front end)";
  const lowHz = fe.frequencyHz + (fe.ifLowHz ?? 0);
  const highHz = fe.frequencyHz + (fe.ifHighHz ?? 0);
  $("fe-coverage").textContent = `${fmtMHz(lowHz)}–${fmtMHz(highHz)} MHz`;
  $("fe-power").textContent = fe.ifPowerDb !== null ? `${fe.ifPowerDb.toFixed(1)} dB` : "—";
  updateSelfEntry(fe);
});

client.addEventListener("tunedFreq", (e) => {
  const { hz } = e.detail;
  $("tuned-freq").textContent = `${fmtMHz(hz)} MHz`;
  $("tune-input").value = (hz / 1000).toFixed(3);
});

client.addEventListener("mode", (e) => {
  $("tuned-mode").textContent = e.detail.mode;
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

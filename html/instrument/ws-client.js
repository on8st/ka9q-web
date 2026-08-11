// Thin client for ka9q-web's WebSocket, covering exactly the two protocols
// documented in this fork: the binary Channel Data TLV stream (status-
// decode.js) for front-end telemetry, and the informal text protocol
// (PROTOCOL-TEXT.md) for tuned frequency/mode. Deliberately independent of
// radio.js - a fresh client against the documented wire protocol, not a
// reuse of radio.js's own code (see INSTRUMENT-DECISIONS.md on why this UI
// is built this way).
import {
  FIELD_DESCRIPTION,
  FIELD_FE_HIGH_EDGE,
  FIELD_FE_ISREAL,
  FIELD_FE_LOW_EDGE,
  FIELD_FIRST_LO_FREQUENCY,
  FIELD_IF_POWER,
  FIELD_INPUT_SAMPRATE,
  FIELD_OUTPUT_CHANNELS,
  FIELD_OUTPUT_ENCODING,
  FIELD_OUTPUT_SAMPRATE,
  asBool,
  asFloat32,
  asFloat64,
  asText,
  asUint,
  decodeChannelDataFields,
} from "./status-decode.js";
import { decodeSpectrumFrame } from "./spectrum-decode.js";
import { decodeAudioFrame } from "./audio-decode.js";

function parseBfreq(raw) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  // Ambiguous by the protocol's own design (see PROTOCOL-TEXT.md): values
  // above 1e6 are already Hz, otherwise kHz. Mirrors radio.js exactly.
  return v > 1_000_000 ? v : v * 1000;
}

export class Ka9qWebClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.clientId = "c" + Math.random().toString(36).slice(2, 10);
    this.seq = 0;
    this.frontend = null; // { descriptionText, frequencyHz, isReal, ifLowHz, ifHighHz, inputSamprate, ifPowerDb }
    this.tunedFreqHz = null; // last BFREQ, or null if this session has never received one (see PROTOCOL-TEXT.md - not guaranteed on connect)
    this.mode = null;
    this.ssrc = null; // from the server's own "S:<ssrc>" text message - required for every A:/O: audio command
    this.audioOutput = null; // { samprate, channels, encoding }, from OUTPUT_SAMPRATE/OUTPUT_CHANNELS/OUTPUT_ENCODING TLV fields - authoritative for PCM playback config, see audio.js
    this._fields = new Map();
    this._ws = null;
  }

  connect() {
    this._ws = new WebSocket(this.url);
    this._ws.binaryType = "arraybuffer";
    this._ws.addEventListener("open", () => {
      // Without this, the dedicated spectrum poller (spectrum_thread,
      // ka9q-web.c) never starts at all and 0x7F frames only trickle in
      // from some other, much slower incidental path - confirmed live via
      // packet capture (PROTOCOL-TEXT.md). Stop-then-start, matching
      // radio.js's own on_ws_open() exactly: STOP first clears stale
      // spectrum state a reattached session (PROTOCOL-TEXT.md - sessions
      // reattach by client IP, not recreate) might still have, then START
      // after a short delay so the STOP is processed first.
      this._sendRaw("S:STOP");
      setTimeout(() => this._sendRaw("S:"), 80);
      this.dispatchEvent(new Event("open"));
    });
    this._ws.addEventListener("close", () => this.dispatchEvent(new Event("close")));
    this._ws.addEventListener("error", (e) => this.dispatchEvent(new CustomEvent("error", { detail: e })));
    this._ws.addEventListener("message", (evt) => this._onMessage(evt));
    return this;
  }

  close() {
    try { this._ws?.close(); } catch (e) { /* ignore */ }
  }

  /** Explicit start/stop, for a future pause-the-spectrum-stream-entirely
   * control (distinct from spectrum-canvas.js's setPaused(), which still
   * receives data but stops drawing it). */
  startSpectrum() { this._sendRaw("S:"); }
  stopSpectrum() { this._sendRaw("S:STOP"); }

  /** S:/S:STOP are sent raw, NOT wrapped in the C:<clientId>:<seq>:
   * envelope every other outbound command uses - confirmed against
   * radio.js's own on_ws_open(), which calls ws.send("S:...") directly. */
  _sendRaw(text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(text);
  }

  /** Sends a tune command (kHz, 3 decimals, per PROTOCOL-TEXT.md) wrapped
   * in the C:<clientId>:<seq>:<raw> envelope. */
  tune(hz) {
    const khz = (Math.round(hz) / 1000.0).toFixed(3);
    this._sendCommand(`F:${khz}`);
  }

  /** Sends a mode/preset change. Unlike tune(), success is NOT echoed back
   * (see PROTOCOL-TEXT.md "Mode confirmation is asymmetric with frequency
   * confirmation") - the ACK is the only confirmation a caller will get
   * that this reached the server at all. */
  setMode(mode) {
    this._sendCommand(`M:${mode}`);
  }

  /** Selects the audio encoding the server transmits for this session -
   * must be sent before startAudio() and re-sent after stopAudio() to
   * keep backend state aligned even while stopped (order ported exactly
   * from radio.js's audio_start_stop()). No-op until this.ssrc is known. */
  setAudioEncoding(usePcm) {
    if (this.ssrc == null) return;
    this._sendCommand(`O:${usePcm ? "PCM" : "OPUS"}:${this.ssrc}`);
  }

  startAudio() {
    if (this.ssrc == null) return;
    this._sendCommand(`A:START:${this.ssrc}`);
  }

  stopAudio() {
    if (this.ssrc == null) return;
    this._sendCommand(`A:STOP:${this.ssrc}`);
  }

  _sendCommand(raw) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this.seq += 1;
    this._ws.send(`C:${this.clientId}:${this.seq}:${raw}`);
  }

  _onMessage(evt) {
    if (typeof evt.data === "string") {
      this._onTextMessage(evt.data);
      return;
    }
    const spectrum = decodeSpectrumFrame(evt.data);
    if (spectrum) {
      this.dispatchEvent(new CustomEvent("spectrum", { detail: spectrum }));
      return;
    }
    const audio = decodeAudioFrame(evt.data);
    if (audio) {
      this.dispatchEvent(new CustomEvent("audioFrame", { detail: audio }));
      return;
    }
    const fields = decodeChannelDataFields(evt.data);
    if (!fields) return;
    for (const [k, v] of fields) this._fields.set(k, v);
    this.frontend = {
      descriptionText: asText(this._fields.get(FIELD_DESCRIPTION)),
      frequencyHz: this._fields.has(FIELD_FIRST_LO_FREQUENCY) ? asFloat64(this._fields.get(FIELD_FIRST_LO_FREQUENCY)) : null,
      isReal: this._fields.has(FIELD_FE_ISREAL) ? asBool(this._fields.get(FIELD_FE_ISREAL)) : null,
      ifLowHz: this._fields.has(FIELD_FE_LOW_EDGE) ? asFloat32(this._fields.get(FIELD_FE_LOW_EDGE)) : null,
      ifHighHz: this._fields.has(FIELD_FE_HIGH_EDGE) ? asFloat32(this._fields.get(FIELD_FE_HIGH_EDGE)) : null,
      inputSamprate: this._fields.has(FIELD_INPUT_SAMPRATE) ? asFloat32(this._fields.get(FIELD_INPUT_SAMPRATE)) : null,
      ifPowerDb: this._fields.has(FIELD_IF_POWER) ? asFloat32(this._fields.get(FIELD_IF_POWER)) : null,
    };
    this.dispatchEvent(new CustomEvent("frontend", { detail: this.frontend }));
    // Backend-reported PCM output config - authoritative for playback
    // (see audio.js), tracked separately from `frontend` since it
    // describes this session's output stream, not the front-end hardware.
    if (this._fields.has(FIELD_OUTPUT_SAMPRATE) || this._fields.has(FIELD_OUTPUT_CHANNELS) || this._fields.has(FIELD_OUTPUT_ENCODING)) {
      this.audioOutput = {
        samprate: this._fields.has(FIELD_OUTPUT_SAMPRATE) ? asUint(this._fields.get(FIELD_OUTPUT_SAMPRATE)) : null,
        channels: this._fields.has(FIELD_OUTPUT_CHANNELS) ? asUint(this._fields.get(FIELD_OUTPUT_CHANNELS)) : null,
        encoding: this._fields.has(FIELD_OUTPUT_ENCODING) ? asUint(this._fields.get(FIELD_OUTPUT_ENCODING)) : null,
      };
    }
  }

  _onTextMessage(text) {
    if (text === "PING") return;
    const args = text.split(":");
    if (args[0] === "BFREQ" || args[0] === "BFREQ_FORCE") {
      const hz = parseBfreq(args[1]);
      if (hz !== null) {
        this.tunedFreqHz = hz;
        this.dispatchEvent(new CustomEvent("tunedFreq", {
          detail: { hz, forced: args[0] === "BFREQ_FORCE" },
        }));
      }
      return;
    }
    if (args[0] === "M" || args[0] === "M_FORCE") {
      this.mode = (args[1] || "").toLowerCase();
      this.dispatchEvent(new CustomEvent("mode", { detail: { mode: this.mode, forced: args[0] === "M_FORCE" } }));
      return;
    }
    if (args[0] === "ACK" && args.length > 2) {
      this.dispatchEvent(new CustomEvent("ack", { detail: { clientId: args[1], seq: parseInt(args[2], 10) } }));
      return;
    }
    if (text.startsWith("BUSY:")) {
      this.dispatchEvent(new CustomEvent("busy", { detail: { reason: text.slice(5).trim() } }));
      return;
    }
    // S:<ssrc> - this session's numeric SSRC, needed to address every
    // A:/O: audio command at this specific session (PROTOCOL-TEXT.md).
    // Distinct from the outbound raw "S:"/"S:STOP" spectrum commands -
    // same letter, unrelated: this one is inbound, with a numeric arg.
    if (args[0] === "S" && args.length > 1 && args[1] !== "") {
      const ssrc = parseInt(args[1], 10);
      if (Number.isFinite(ssrc)) {
        this.ssrc = ssrc;
        this.dispatchEvent(new CustomEvent("ssrc", { detail: { ssrc } }));
      }
      return;
    }
    // Other prefixes not yet needed by this UI are ignored.
  }
}

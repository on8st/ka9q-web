// Thin client for ka9q-web's WebSocket, covering exactly the two protocols
// documented in this fork: the binary Channel Data TLV stream (status-
// decode.js) for front-end telemetry, and the informal text protocol
// (PROTOCOL-TEXT.md) for tuned frequency/mode. Deliberately independent of
// radio.js - a fresh client against the documented wire protocol, not a
// reuse of radio.js's own code (see INSTRUMENT-DECISIONS.md on why this UI
// is built this way).
import {
  FIELD_BASEBAND_POWER,
  FIELD_DESCRIPTION,
  FIELD_FE_HIGH_EDGE,
  FIELD_FE_ISREAL,
  FIELD_FE_LOW_EDGE,
  FIELD_FIRST_LO_FREQUENCY,
  FIELD_HIGH_EDGE,
  FIELD_IF_POWER,
  FIELD_INPUT_SAMPRATE,
  FIELD_LOW_EDGE,
  FIELD_NOISE_DENSITY,
  FIELD_OUTPUT_CHANNELS,
  FIELD_OUTPUT_ENCODING,
  FIELD_OUTPUT_SAMPRATE,
  FIELD_SAMPLES_SINCE_OVER,
  asBool,
  asDbFromLinearPower,
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
    this.zoomTableSize = null; // from "ZSIZE:<n>", the reply to a raw "Z:SIZE" query - number of valid zoom-table indices for this front end (radio.js's fetchZoomTableSize())
    this.filterEdges = null; // { lowHz, highHz }, from Channel Data FIELD_LOW_EDGE/FIELD_HIGH_EDGE (39/40) - confirms a sent e:<low>:<high> took effect
    this.shiftHz = null; // from the inbound "SHIFT:<hz>" text message (PROTOCOL-TEXT.md) - the post-detection audio offset, sent unconditionally on connect/change
    this.signalMetrics = null; // { basebandPowerDb, noiseDensityDb, samplesSinceOver }, from Channel Data - the SNR/OVR S-meter metrics' raw inputs (see meter.js for the actual SNR/OVR math)
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
      this.queryZoomTableSize();
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

  /** Queries how many zoom-table entries this front end has - reply
   * arrives as a "ZSIZE:<n>" text message (_onTextMessage). Sent raw, not
   * wrapped - ported from radio.js's getZoomTableSize(), which also
   * bypasses sendControl()'s C: envelope for this one query. */
  queryZoomTableSize() { this._sendRaw("Z:SIZE"); }

  /** Selects a zoom-table entry by its integer index (0..zoomTableSize-1),
   * NOT a target span/Hz-per-bin value - the index maps 1:1 onto the
   * server's own zoom_table[] (ka9q-web.c), same array the "Zoom level"
   * slider drives in radio.js (setZoom()). */
  setZoomLevel(index) {
    this._sendCommand(`Z:${index}`);
  }

  /** Relative zoom step, ported from radio.js's zoomin()/zoomout() -
   * these carry the currently-tuned frequency so the server can re-center
   * while stepping. direction: +1 to zoom in, -1 to zoom out. */
  zoomStep(direction, freqHz) {
    const khz = (Math.round(freqHz) / 1000.0).toFixed(3);
    this._sendCommand(`Z:${direction > 0 ? "+" : "-"}:${khz}`);
  }

  /** Re-centers the zoom window on the given frequency without changing
   * zoom level - ported from radio.js's zoomcenter() ("Zoom Center"
   * button; ka9q-web.c's Z:c: handler). */
  zoomCenter(freqHz) {
    const khz = (Math.round(freqHz) / 1000.0).toFixed(3);
    this._sendCommand(`Z:c:${khz}`);
  }

  /** Server-side FFT averaging count (radiod's own SPECTRUM_AVG, not the
   * client-side EMA "FFT averaging amount" fft_avg_input drives - that
   * one never touches the wire, see spectrum-canvas.js). Ported from
   * radio.js's setupSpectrumAvgInput() -> 'g:<n>'. */
  setSpectrumAverage(n) {
    this._sendCommand(`g:${Math.round(n)}`);
  }

  /** FFT window type + shape parameter (Kaiser beta / Gaussian alpha).
   * Ported from radio.js's sendWindowParameter() -> 'w:<TYPE>:<PARAM>'.
   * `windowType` is the enum NAME string (e.g. "KAISER_WINDOW"), matching
   * ka9q-web.c's control_set_window_type() string mapping, not an index. */
  setWindow(windowType, param) {
    this._sendCommand(`w:${windowType}:${param}`);
  }

  /** FFT window overlap fraction (0..1). Ported from radio.js's
   * sendSpectrumOverlap() -> 'v:<float>'. */
  setSpectrumOverlap(v) {
    this._sendCommand(`v:${v}`);
  }

  /** How often (ms) ka9q-web itself polls radiod for fresh spectrum data
   * for this session (ka9q-web-internal - sp->spectrum_poll_us, ported
   * from radio.js's sendSpectrumPoll() -> 'r:<ms>'). Does NOT reach
   * radiod's own FFT computation, unlike setSpectrumAverage/setWindow/
   * setSpectrumOverlap above - it only changes how often ka9q-web asks. */
  setSpectrumPollRate(ms) {
    this._sendCommand(`r:${Math.round(ms)}`);
  }

  /** Demod filter passband edges (Hz offsets from the tuned carrier, not
   * absolute Hz - e.g. USB is roughly 50..3000). Always sent as a pair,
   * ported from radio.js's sendFilterEdges() -> 'e:<low>:<high>'. Also
   * the underlying command QuickBW uses to swap in/out its alternate
   * bandwidth preset - there is no separate QuickBW wire command. */
  setFilterEdges(lowHz, highHz) {
    this._sendCommand(`e:${Math.round(lowHz)}:${Math.round(highHz)}`);
  }

  /** Post-detection audio shift (BFO-style Hz offset - the CW sidetone
   * pitch in CWU/CWL, meaningful in any mode). Ported from radio.js's
   * sendShift() -> 't:<hz>'. Confirmed by name against the inbound
   * "SHIFT:<hz>" echo (PROTOCOL-TEXT.md) this sets. */
  setShift(hz) {
    this._sendCommand(`t:${Math.round(hz)}`);
  }

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
    // Demod filter edges (39/40) - confirms a sent setFilterEdges() took
    // effect; distinct from FIELD_FE_LOW_EDGE/HIGH_EDGE (100/101, the
    // front end's own IF window, already in `frontend` above).
    if (this._fields.has(FIELD_LOW_EDGE) && this._fields.has(FIELD_HIGH_EDGE)) {
      this.filterEdges = {
        lowHz: asFloat32(this._fields.get(FIELD_LOW_EDGE)),
        highHz: asFloat32(this._fields.get(FIELD_HIGH_EDGE)),
      };
      this.dispatchEvent(new CustomEvent("filterEdges", { detail: this.filterEdges }));
    }
    // Raw inputs for the "S-meter metric" feature's Signal/SNR options -
    // Signal itself also comes from basebandPowerDb now (issue 5: it was
    // wired to `frontend`'s ifPowerDb, a front-end-wide field that
    // doesn't track the tuned channel at all - see meter.js's header
    // comment), noiseDensityDb/samplesSinceOver are SNR/OVR-specific.
    // All demod-specific, Channel-Data-only.
    if (this._fields.has(FIELD_BASEBAND_POWER) || this._fields.has(FIELD_NOISE_DENSITY) || this._fields.has(FIELD_SAMPLES_SINCE_OVER)) {
      this.signalMetrics = {
        basebandPowerDb: this._fields.has(FIELD_BASEBAND_POWER) ? asDbFromLinearPower(this._fields.get(FIELD_BASEBAND_POWER)) : null,
        noiseDensityDb: this._fields.has(FIELD_NOISE_DENSITY) ? asFloat32(this._fields.get(FIELD_NOISE_DENSITY)) : null,
        samplesSinceOver: this._fields.has(FIELD_SAMPLES_SINCE_OVER) ? asUint(this._fields.get(FIELD_SAMPLES_SINCE_OVER)) : null,
      };
      this.dispatchEvent(new CustomEvent("signalMetrics", { detail: this.signalMetrics }));
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
    if (args[0] === "SHIFT") {
      const hz = parseFloat(args[1]);
      if (Number.isFinite(hz)) {
        this.shiftHz = hz;
        this.dispatchEvent(new CustomEvent("shift", { detail: { hz } }));
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
    if (text.startsWith("ZSIZE:")) {
      const n = parseInt(text.slice(6), 10);
      if (Number.isFinite(n)) {
        this.zoomTableSize = n;
        this.dispatchEvent(new CustomEvent("zoomTableSize", { detail: { size: n } }));
      }
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

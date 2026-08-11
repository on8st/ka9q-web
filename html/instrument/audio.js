// Audio playback for the instrument UI. Ported from html/pcm-player.js and
// html/opus-decoder.min.js (both vendored, loaded as classic <script> tags
// by index.html so they attach to window - see the <script> tags there)
// plus html/radio.js's audio_start_stop()/PT-byte switch. Distinct wire
// behaviour from spectrum/channel-data (documented as found while porting):
//  - Audio commands are wrapped in the C:<clientId>:<seq>: envelope
//    (unlike spectrum's raw S:/S:STOP) and need this session's numeric
//    SSRC (ws-client.js's client.ssrc, from the server's own "S:<ssrc>"
//    text message) - see ws-client.js's setAudioEncoding()/startAudio().
//  - Start sequence: select encoding (O:PCM/O:OPUS) THEN A:START. Stop:
//    A:STOP THEN re-select encoding (keeps backend state aligned even
//    while stopped) - order matters both ways, mirrors radio.js exactly.
//  - PCM sample rate/channel count must come from backend TLV metadata
//    (client.audioOutput), never guessed from mode - stereo modes like
//    ISB/user1 need the real backend-reported layout.
//  - Toggling PCM<->Opus while already playing is NOT a stop/restart
//    cycle - ported from radio.js's onPcmCheckboxChange(): a single
//    O:PCM/O:OPUS command switches the backend's live encoding, A:START
//    stays untouched.
const VOLUME_MIN_GAIN = 0;
const VOLUME_MAX_GAIN = 4; // over-unity on purpose, matches radio.js's setPlayerVolume()
const VOLUME_EXPONENT = 2.5;

export function sliderToGain(slider) {
  return VOLUME_MIN_GAIN + (VOLUME_MAX_GAIN - VOLUME_MIN_GAIN) * Math.pow(slider, VOLUME_EXPONENT);
}

export function createAudioPlayer(client) {
  let player = null;
  let opusDecoder = null;
  let opusDecoderReady = false;
  let usePcm = true;
  let playing = false;
  let recording = false;
  let lastVolumeSlider = 1;

  function pcmConfig() {
    const cfg = client.audioOutput;
    if (cfg && Number.isFinite(cfg.samprate) && cfg.samprate > 0 && Number.isFinite(cfg.channels) && cfg.channels > 0) {
      return { sampleRate: cfg.samprate, channels: cfg.channels };
    }
    // No backend metadata yet - safe placeholder until the first Channel
    // Data frame with OUTPUT_SAMPRATE/OUTPUT_CHANNELS arrives (typically
    // within the first second), matching radio.js's initial player config.
    return { sampleRate: 12000, channels: 1 };
  }

  function ensurePcmPlayer() {
    const cfg = pcmConfig();
    const needsRecreate = !player || !player.audioCtx || player.audioCtx.state === "closed"
      || !player.option || player.option.encoding !== "16bitInt"
      || Number(player.option.channels) !== Number(cfg.channels)
      || Number(player.option.sampleRate) !== Number(cfg.sampleRate);
    if (needsRecreate) {
      try { player?.destroy(); } catch (e) { /* ignore */ }
      player = new window.PCMPlayer({ encoding: "16bitInt", channels: cfg.channels, sampleRate: cfg.sampleRate, flushingTime: 250 });
      player.volume(sliderToGain(lastVolumeSlider));
      player.pan(lastPan);
    } else if (player.audioCtx.state === "suspended") {
      player.resume();
    }
  }

  function setVolume(slider) {
    lastVolumeSlider = slider;
    if (player) player.volume(sliderToGain(slider));
  }

  // "panner_control" - stereo audio pan (-1..1), unrelated to spectrum
  // view panning (Z:c:) or the display "cursor" marker - three separate
  // stock features that happen to share loose naming. PCMPlayer already
  // has a pan() method (pcm-player.js's StereoPannerNode) - reused as-is.
  let lastPan = 0;
  function setPan(v) {
    lastPan = Number(v) || 0;
    if (player) player.pan(lastPan);
  }

  async function initOpusDecoder() {
    try {
      opusDecoder = new window["opus-decoder"].OpusDecoder();
      await opusDecoder.ready;
      opusDecoderReady = true;
    } catch (e) { console.error("Failed to initialize Opus decoder:", e); }
  }

  function destroyOpusDecoder() {
    try { opusDecoder?.free(); } catch (e) { /* ignore */ }
    opusDecoder = null;
    opusDecoderReady = false;
  }

  function handlePcm(payload) {
    ensurePcmPlayer();
    player.feed(payload);
  }

  function handleOpus(payload) {
    if (!opusDecoderReady || !opusDecoder) return;
    try {
      const result = opusDecoder.decodeFrame(payload);
      if (!result || result.samplesDecoded <= 0) return;
      const channels = result.channelData?.length || 1;
      const samples = result.samplesDecoded;
      const interleaved = new Float32Array(samples * channels);
      for (let s = 0; s < samples; s++) {
        for (let c = 0; c < channels; c++) interleaved[s * channels + c] = result.channelData[c] ? result.channelData[c][s] : 0;
      }
      if (!player || !player.audioCtx || player.option.encoding !== "32bitFloat"
          || player.option.sampleRate !== result.sampleRate || Number(player.option.channels) !== Number(channels)) {
        try { player?.destroy(); } catch (e) { /* ignore */ }
        player = new window.PCMPlayer({ encoding: "32bitFloat", channels, sampleRate: result.sampleRate, flushingTime: 250 });
        player.volume(sliderToGain(lastVolumeSlider));
        player.pan(lastPan);
      }
      player.feed(interleaved);
    } catch (e) { console.warn("Opus decode error:", e); }
  }

  client.addEventListener("audioFrame", (e) => {
    const { encoding, payload } = e.detail;
    if (encoding === "pcm") handlePcm(payload);
    else if (encoding === "opus") handleOpus(payload);
  });

  async function start() {
    if (playing) return;
    playing = true;
    if (usePcm) {
      destroyOpusDecoder();
      client.setAudioEncoding(true);
      ensurePcmPlayer();
      client.startAudio();
    } else {
      await initOpusDecoder();
      client.setAudioEncoding(false);
      client.startAudio();
    }
  }

  function stop() {
    if (!playing) return;
    playing = false;
    client.stopAudio();
    client.setAudioEncoding(usePcm); // keep backend encoding state aligned even while stopped
    destroyOpusDecoder();
  }

  /** Ported from radio.js's onPcmCheckboxChange(): while playing, this
   * switches encoding live with a single O:PCM/O:OPUS command - NOT a
   * stop/restart cycle (A:START/A:STOP stays untouched). */
  function setPcm(v) {
    const next = !!v;
    if (next === usePcm) return;
    usePcm = next;
    if (next) {
      destroyOpusDecoder();
      if (playing) client.setAudioEncoding(true);
      ensurePcmPlayer();
    } else {
      initOpusDecoder();
      if (playing) client.setAudioEncoding(false);
    }
  }

  /** Returns the new recording state (true = now recording), or null if
   * audio isn't playing (matches radio.js's "start audio first" guard). */
  function toggleRecording(freqKhz, mode) {
    if (!playing || !player) return null;
    if (recording) {
      player.stopRecording(freqKhz, mode);
    } else {
      player.startRecording();
    }
    recording = !recording;
    return recording;
  }

  return {
    start,
    stop,
    setVolume,
    setPan,
    setPcm,
    toggleRecording,
    isPlaying: () => playing,
    isRecording: () => recording,
    isPcm: () => usePcm,
  };
}

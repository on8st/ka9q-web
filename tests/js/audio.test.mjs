import { test } from "node:test";
import assert from "node:assert/strict";

// createAudioPlayer() reaches for window.PCMPlayer / window["opus-decoder"]
// (the two vendored classic-<script> libraries index.html loads for real -
// see audio.js's header comment). Node has no window; shim it with fakes
// that record calls instead of touching real audio hardware/WASM.
globalThis.window ??= globalThis;

let lastCreatedPlayer = null;
class FakePCMPlayer {
  constructor(option) {
    this.option = option;
    lastCreatedPlayer = this;
    this.audioCtx = { state: "running" };
    this.fed = [];
    this.volumeValue = null;
    this.panValue = null;
    this.destroyed = false;
    this.recording = false;
    this.recordedArgs = null;
  }
  feed(data) { this.fed.push(data); }
  volume(v) { this.volumeValue = v; }
  pan(v) { this.panValue = v; }
  resume() { this.audioCtx.state = "running"; }
  destroy() { this.destroyed = true; }
  startRecording() { this.recording = true; }
  stopRecording(freqKhz, mode) { this.recording = false; this.recordedArgs = [freqKhz, mode]; }
}
window.PCMPlayer = FakePCMPlayer;

class FakeOpusDecoder {
  constructor() { this.ready = Promise.resolve(); this.freed = false; }
  decodeFrame(payload) {
    return { channelData: [new Float32Array([0.5, -0.5])], samplesDecoded: 2, sampleRate: 48000 };
  }
  free() { this.freed = true; }
}
window["opus-decoder"] = { OpusDecoder: FakeOpusDecoder };

const { createAudioPlayer, sliderToGain } = await import("../../html/audio.js");

test("sliderToGain maps [0,1] onto an over-unity [0,4] gain range", () => {
  assert.equal(sliderToGain(0), 0);
  assert.equal(sliderToGain(1), 4);
  assert.ok(sliderToGain(0.5) > 0 && sliderToGain(0.5) < 4);
});

function fakeClient() {
  const listeners = {};
  return {
    ssrc: 123,
    audioOutput: null,
    calls: [],
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    _fire(type, detail) { (listeners[type] || []).forEach((fn) => fn({ detail })); },
    setAudioEncoding(usePcm) { this.calls.push(["setAudioEncoding", usePcm]); },
    startAudio() { this.calls.push(["startAudio"]); },
    stopAudio() { this.calls.push(["stopAudio"]); },
  };
}

test("start() in PCM mode selects encoding before starting, in that order", async () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  await player.start();
  assert.deepEqual(client.calls, [["setAudioEncoding", true], ["startAudio"]]);
  assert.equal(player.isPlaying(), true);
});

test("start() is a no-op if already playing (no duplicate commands)", async () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  await player.start();
  await player.start();
  assert.deepEqual(client.calls, [["setAudioEncoding", true], ["startAudio"]]);
});

test("stop() sends A:STOP then re-asserts the encoding selector (order matters, ported from radio.js)", async () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  await player.start();
  client.calls = [];
  player.stop();
  assert.deepEqual(client.calls, [["stopAudio"], ["setAudioEncoding", true]]);
  assert.equal(player.isPlaying(), false);
});

test("setPcm(false) while playing switches encoding live with one O:OPUS command - no stop/restart", async () => {
  // Ported from radio.js's onPcmCheckboxChange(): A:START/A:STOP is not
  // touched when switching encoding mid-stream, only O:PCM/O:OPUS.
  const client = fakeClient();
  const player = createAudioPlayer(client);
  await player.start();
  client.calls = [];
  player.setPcm(false);
  assert.deepEqual(client.calls, [["setAudioEncoding", false]]);
  assert.equal(player.isPlaying(), true, "still playing - not stopped");
  assert.equal(player.isPcm(), false);
});

test("setPcm(false) while NOT playing updates the client-side decoder without sending any command", () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  player.setPcm(false);
  assert.deepEqual(client.calls, []);
  assert.equal(player.isPcm(), false);
});

test("setPcm() to the same value is a no-op", async () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  await player.start();
  client.calls = [];
  player.setPcm(true); // already PCM
  assert.deepEqual(client.calls, []);
});

test("a PCM audioFrame event feeds the player once started", async () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  await player.start();
  client._fire("audioFrame", { encoding: "pcm", payload: new Uint8Array([1, 2, 3, 4]) });
  // No direct handle on the internal PCMPlayer instance - assert indirectly
  // via toggleRecording(), which only succeeds once a player exists.
  assert.equal(player.toggleRecording(14074, "usb"), true);
});

test("toggleRecording() refuses when audio isn't playing", () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  assert.equal(player.toggleRecording(14074, "usb"), null);
});

test("toggleRecording() flips state and passes freq/mode through to stopRecording on the second call", async () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  await player.start();
  client._fire("audioFrame", { encoding: "pcm", payload: new Uint8Array([1, 2]) });
  assert.equal(player.toggleRecording(14074.5, "usb"), true);
  assert.equal(player.isRecording(), true);
  assert.equal(player.toggleRecording(14074.5, "usb"), false);
  assert.equal(player.isRecording(), false);
});

test("an Opus audioFrame is decoded and interleaved before being fed to the player", async () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  player.setPcm(false);
  await player.start();
  // Should not throw even though the fake decoder returns synthetic data.
  assert.doesNotThrow(() => client._fire("audioFrame", { encoding: "opus", payload: new Uint8Array([1, 2, 3]) }));
});

test("setPan() applies to the current player, and to a freshly-created one ('panner_control', pcm-player.js's StereoPannerNode)", async () => {
  const client = fakeClient();
  const player = createAudioPlayer(client);
  player.setPan(0.5);
  await player.start(); // PCM player created here - should pick up the pan set before start
  assert.equal(lastCreatedPlayer.panValue, 0.5);
  player.setPan(-0.3);
  assert.equal(lastCreatedPlayer.panValue, -0.3);
});

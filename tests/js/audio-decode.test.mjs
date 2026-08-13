import { test } from "node:test";
import assert from "node:assert/strict";
import { OPUS_PT, PCM_PT_HINTS, decodeAudioFrame } from "../../html/audio-decode.js";

function frameWithPt(pt, payloadBytes) {
  const buf = new ArrayBuffer(12 + payloadBytes.length);
  new DataView(buf).setUint32(0, (pt << 16), false);
  new Uint8Array(buf, 12).set(payloadBytes);
  return buf;
}

test("decodeAudioFrame returns null for frames shorter than the RTP header", () => {
  assert.equal(decodeAudioFrame(new ArrayBuffer(8)), null);
});

test("decodeAudioFrame returns null for non-audio PT bytes (Channel Data 0x7E, Spectrum Data 0x7F)", () => {
  assert.equal(decodeAudioFrame(frameWithPt(0x7e, [1, 2, 3])), null);
  assert.equal(decodeAudioFrame(frameWithPt(0x7f, [1, 2, 3])), null);
});

test("decodeAudioFrame recognises the Opus PT (0x6F) and passes the payload through unchanged", () => {
  const result = decodeAudioFrame(frameWithPt(OPUS_PT, [10, 20, 30]));
  assert.equal(result.encoding, "opus");
  assert.equal(result.ptHint, null);
  assert.deepEqual(Array.from(result.payload), [10, 20, 30]);
});

test("decodeAudioFrame recognises every documented PCM PT and reports its sample-rate/channel hint", () => {
  // radio.js's own PT table (html/radio.js:1932-1939), ported.
  assert.deepEqual(PCM_PT_HINTS[0x70], { sampleRate: 48000, channels: 1 });
  assert.deepEqual(PCM_PT_HINTS[0x71], { sampleRate: 48000, channels: 2 });
  assert.deepEqual(PCM_PT_HINTS[0x7a], { sampleRate: 12000, channels: 1 });
  assert.deepEqual(PCM_PT_HINTS[0x7b], { sampleRate: 12000, channels: 2 }); // ISB uses this one
  assert.deepEqual(PCM_PT_HINTS[0x7d], { sampleRate: 8000, channels: 1 });

  const result = decodeAudioFrame(frameWithPt(0x7a, [1, 2, 3, 4]));
  assert.equal(result.encoding, "pcm");
  assert.deepEqual(result.ptHint, { sampleRate: 12000, channels: 1 });
});

test("decodeAudioFrame byte-swaps PCM payload from wire S16BE to native-endian bytes", () => {
  // Two S16BE samples: 0x0102 and 0x0304 -> swapped to 0x02,0x01,0x04,0x03.
  const result = decodeAudioFrame(frameWithPt(0x7a, [0x01, 0x02, 0x03, 0x04]));
  assert.deepEqual(Array.from(result.payload), [0x02, 0x01, 0x04, 0x03]);
});

test("decodeAudioFrame respects a non-zero CSRC count (cc) when locating the payload", () => {
  const cc = 2;
  const buf = new ArrayBuffer(12 + cc * 4 + 2);
  new DataView(buf).setUint32(0, (OPUS_PT << 16) | (cc << 24), false);
  new Uint8Array(buf, 12 + cc * 4).set([9, 9]);
  const result = decodeAudioFrame(buf);
  assert.equal(result.encoding, "opus");
  assert.deepEqual(Array.from(result.payload), [9, 9]);
});

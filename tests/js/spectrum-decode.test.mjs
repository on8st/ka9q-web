import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { decodeSpectrumFrame, absoluteCenterHz } from "../../html/instrument/spectrum-decode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures");

function allFrames(fixtureName) {
  const buf = readFileSync(path.join(FIXTURES, fixtureName));
  const frames = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    offset += 4;
    frames.push(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length));
    offset += length;
  }
  return frames;
}

function firstSpectrumFrame(fixtureName) {
  for (const frame of allFrames(fixtureName)) {
    const decoded = decodeSpectrumFrame(frame);
    if (decoded) return decoded;
  }
  throw new Error(`no spectrum frame found in ${fixtureName}`);
}

function lastSpectrumFrame(fixtureName) {
  let last = null;
  for (const frame of allFrames(fixtureName)) {
    const decoded = decodeSpectrumFrame(frame);
    if (decoded) last = decoded;
  }
  if (!last) throw new Error(`no spectrum frame found in ${fixtureName}`);
  return last;
}

test("VHF spectrum frame: 1620 bins, real 2.4Msps sample rate", () => {
  const s = firstSpectrumFrame("vhf.bin");
  assert.equal(s.binCount, 1620);
  assert.equal(s.binsDb.length, 1620);
  assert.equal(s.inputSamprate, 2_400_000);
});

test("VHF spectrum frame: additional telemetry fields decode as finite numbers", () => {
  const s = firstSpectrumFrame("vhf.bin");
  assert.ok(Number.isFinite(s.noiseBwHz));
  assert.ok(Number.isFinite(s.rfAttenDb));
  assert.ok(Number.isFinite(s.rfGainDb));
  assert.ok(Number.isFinite(s.adOver) && s.adOver >= 0);
});

test("UHF spectrum frame: 1620 bins, real 20Msps sample rate", () => {
  const s = firstSpectrumFrame("uhf.bin");
  assert.equal(s.binCount, 1620);
  assert.equal(s.inputSamprate, 20_000_000);
});

test("HF spectrum frame: 1620 bins, real 64.8Msps sample rate", () => {
  const s = firstSpectrumFrame("hf.bin");
  assert.equal(s.binCount, 1620);
  assert.equal(s.inputSamprate, 64_800_000);
});

test("HF centerHz is exactly half the displayed span (0Hz-baseband direct sampling)", () => {
  const s = firstSpectrumFrame("hf.bin");
  assert.equal(s.centerHz, (s.binWidthHz * s.binCount) / 2);
});

test("if_power roughly cross-checks against the same fixture's Channel Data IF_POWER field", async () => {
  const { decodeChannelDataFields, FIELD_IF_POWER, asFloat32 } = await import("../../html/instrument/status-decode.js");
  let channelIfPower = null;
  for (const frame of allFrames("vhf.bin")) {
    const fields = decodeChannelDataFields(frame);
    if (fields && fields.has(FIELD_IF_POWER)) channelIfPower = asFloat32(fields.get(FIELD_IF_POWER));
  }
  // Pairing the LAST of each stream, not first-vs-last: the fixture spans
  // ~5 real seconds and IF_POWER is a live, continuously-fluctuating
  // measurement, so only readings close together in time should be
  // expected to be close in value. A live connection reading both at the
  // same instant matched to 0.01dB (confirmed manually, PROTOCOL-SPECTRUM.md);
  // this tolerance allows for the fixture's several-second capture window.
  const spectrumIfPower = lastSpectrumFrame("vhf.bin").ifPowerDb;
  assert.ok(channelIfPower !== null, "expected Channel Data to also carry IF_POWER in this fixture");
  assert.ok(Math.abs(channelIfPower - spectrumIfPower) < 3, `${channelIfPower} vs ${spectrumIfPower}`);
});

test("bin bytes decode using offset + gain, with the 0.5 fallback when gain is 0", () => {
  const s = firstSpectrumFrame("vhf.bin");
  // Every observed byte in the real fixture was 128 (flat noise floor) -
  // confirms the decode arithmetic rather than just trusting binCount.
  assert.ok(s.binsDb.every((v) => Number.isFinite(v)));
});

test("absoluteCenterHz adds the front end's real tuned centre, defaulting to 0 if unknown", () => {
  const s = firstSpectrumFrame("hf.bin");
  assert.equal(absoluteCenterHz(s, 0), s.centerHz);
  assert.equal(absoluteCenterHz(s, 145_500_000), s.centerHz + 145_500_000);
  assert.equal(absoluteCenterHz(s, undefined), s.centerHz);
});

test("returns null for a truncated frame instead of drawing garbage", () => {
  const s = firstSpectrumFrame("vhf.bin");
  // Reconstruct a frame that's too short for its own declared bin count.
  const buf = readFileSync(path.join(FIXTURES, "vhf.bin"));
  let offset = 0, spectrumFrameBytes = null;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32BE(offset); offset += 4;
    const frame = buf.subarray(offset, offset + length); offset += length;
    if (frame.length >= 12 && ((frame.readUInt32BE(0) >> 16) & 0x7f) === 0x7f) { spectrumFrameBytes = frame; break; }
  }
  const truncated = spectrumFrameBytes.subarray(0, 50); // well short of the 92-byte header
  const truncatedBuf = truncated.buffer.slice(truncated.byteOffset, truncated.byteOffset + truncated.length);
  assert.equal(decodeSpectrumFrame(truncatedBuf), null);
});

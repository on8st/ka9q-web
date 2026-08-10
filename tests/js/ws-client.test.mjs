// Exercises Ka9qWebClient's protocol handling directly, without opening a
// real WebSocket (its connect()/tune() are the only methods that touch the
// WebSocket global - not called here). Feeds real captured binary frames
// and real text-protocol strings confirmed live against the actual
// receivers (see PROTOCOL-TEXT.md) through the same _onMessage/
// _onTextMessage paths connect() would use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Ka9qWebClient } from "../../html/instrument/ws-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures");

function firstFrameOfType(fixtureName, pktType) {
  const buf = readFileSync(path.join(FIXTURES, fixtureName));
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    offset += 4;
    const frame = buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length);
    offset += length;
    if (frame.byteLength >= 12) {
      const word0 = new DataView(frame).getUint32(0, false);
      if (((word0 >> 16) & 0x7f) === pktType) return frame;
    }
  }
  throw new Error(`no 0x${pktType.toString(16)} frame found in ${fixtureName}`);
}

function firstChannelDataFrame(fixtureName) {
  return firstFrameOfType(fixtureName, 0x7e);
}

test("binary frame updates client.frontend and fires a frontend event", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let eventDetail = null;
  client.addEventListener("frontend", (e) => { eventDetail = e.detail; });

  client._onMessage({ data: firstChannelDataFrame("vhf.bin") });

  assert.ok(client.frontend, "frontend state should be populated");
  assert.equal(client.frontend.descriptionText, "2m - RTL-SDR");
  assert.equal(client.frontend.isReal, false);
  assert.ok(client.frontend.frequencyHz > 144_000_000 && client.frontend.frequencyHz < 148_000_000);
  assert.deepEqual(eventDetail, client.frontend);
});

test("spectrum frame fires a spectrum event and does not update frontend/frontend event", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let spectrumDetail = null;
  let frontendFired = false;
  client.addEventListener("spectrum", (e) => { spectrumDetail = e.detail; });
  client.addEventListener("frontend", () => { frontendFired = true; });

  client._onMessage({ data: firstFrameOfType("vhf.bin", 0x7f) });

  assert.ok(spectrumDetail, "spectrum event should have fired");
  assert.equal(spectrumDetail.binCount, 1620);
  assert.equal(spectrumDetail.binsDb.length, 1620);
  assert.equal(spectrumDetail.inputSamprate, 2_400_000);
  assert.equal(frontendFired, false, "a spectrum frame is not Channel Data and must not be mistaken for one");
});

test("BFREQ below the 1e6 threshold is interpreted as kHz", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let detail = null;
  client.addEventListener("tunedFreq", (e) => { detail = e.detail; });

  client._onTextMessage("BFREQ:14250.000"); // 14250 kHz = 14.25 MHz

  assert.equal(detail.hz, 14_250_000);
  assert.equal(detail.forced, false);
  assert.equal(client.tunedFreqHz, 14_250_000);
});

test("BFREQ above the 1e6 threshold is interpreted as already-Hz", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let detail = null;
  client.addEventListener("tunedFreq", (e) => { detail = e.detail; });

  // Confirmed live 2026-08-10 (PROTOCOL-TEXT.md): server echoes a real tune
  // in Hz once the value exceeds the protocol's own 1e6 ambiguity threshold.
  client._onTextMessage("BFREQ:145500000.000");

  assert.equal(detail.hz, 145_500_000);
});

test("BFREQ_FORCE sets forced: true", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let detail = null;
  client.addEventListener("tunedFreq", (e) => { detail = e.detail; });
  client._onTextMessage("BFREQ_FORCE:145500000.000");
  assert.equal(detail.forced, true);
});

test("M: sets mode and fires a mode event", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let detail = null;
  client.addEventListener("mode", (e) => { detail = e.detail; });
  client._onTextMessage("M:usb");
  assert.equal(client.mode, "usb");
  assert.equal(detail.mode, "usb");
  assert.equal(detail.forced, false);
});

test("ACK: fires an ack event with clientId and numeric seq", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let detail = null;
  client.addEventListener("ack", (e) => { detail = e.detail; });
  client._onTextMessage("ACK:ctest001:1"); // confirmed live 2026-08-10, PROTOCOL-TEXT.md
  assert.deepEqual(detail, { clientId: "ctest001", seq: 1 });
});

test("BUSY: fires a busy event with the reason", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let detail = null;
  client.addEventListener("busy", (e) => { detail = e.detail; });
  client._onTextMessage("BUSY: session limit reached");
  assert.equal(detail.reason, "session limit reached");
});

test("PING is ignored without throwing or firing any event", () => {
  const client = new Ka9qWebClient("ws://unused/");
  let fired = false;
  for (const ev of ["tunedFreq", "mode", "ack", "busy", "frontend"]) {
    client.addEventListener(ev, () => { fired = true; });
  }
  assert.doesNotThrow(() => client._onTextMessage("PING"));
  assert.equal(fired, false);
});

// Node has no global WebSocket by default (real browsers always do) -
// _sendCommand's readyState check needs the WebSocket.OPEN constant to
// exist. This is a test-only shim, not a change to what ships.
globalThis.WebSocket ??= { OPEN: 1 };

function mockSocket() {
  const sent = [];
  return { sent, ws: { readyState: WebSocket.OPEN, send: (msg) => sent.push(msg) } };
}

test("tune() sends F:<khz> wrapped in the C:<clientId>:<seq> envelope", () => {
  const client = new Ka9qWebClient("ws://unused/");
  client.clientId = "ctest";
  const { sent, ws } = mockSocket();
  client._ws = ws;

  client.tune(145_500_000);

  assert.equal(sent.length, 1);
  assert.equal(sent[0], "C:ctest:1:F:145500.000");
});

test("setMode() sends M:<mode> wrapped the same way, with an incrementing seq", () => {
  const client = new Ka9qWebClient("ws://unused/");
  client.clientId = "ctest";
  const { sent, ws } = mockSocket();
  client._ws = ws;

  client.tune(14_250_000);
  client.setMode("usb");

  assert.equal(sent[0], "C:ctest:1:F:14250.000");
  assert.equal(sent[1], "C:ctest:2:M:usb");
});

test("commands are silently dropped when the socket isn't open (no throw)", () => {
  const client = new Ka9qWebClient("ws://unused/");
  client._ws = { readyState: 0 /* CONNECTING */, send: () => { throw new Error("should not be called"); } };
  assert.doesNotThrow(() => client.tune(14_250_000));
  assert.doesNotThrow(() => client.setMode("fm"));
});

// Minimal decoder for ka9q-web's binary WebSocket "Channel Data" packets.
// Port of tests/decode_status.py - keep both in sync; that Python module is
// the one covered by tests/test_vhf_uhf_frontend_regression.py against real
// captured traffic, this is the same wire format for the browser.
//
// Wire format (see tests/decode_status.py for the full derivation from
// html/radio.js and status.c):
//   - 12+ byte RTP-style header: word0 (version/pad/ext/cc/type/seq),
//     timestamp, ssrc, then cc*4 bytes of CSRCs.
//   - `type` (bits 16-22 of word0) selects the payload kind. 0x7E is
//     "Channel Data": a flat sequence of (type: uint8, length: uint8,
//     value: length bytes) TLV fields, running to the end of the packet.
//   - Multi-byte integers/floats are big-endian with leading zero bytes
//     suppressed (status.c encode_int64) - reconstruct by left-padding
//     with zero bytes to the natural width before interpreting.

export const CHANNEL_DATA_TYPE = 0x7e;

export const FIELD_DESCRIPTION = 4;
export const FIELD_INPUT_SAMPRATE = 10;
export const FIELD_IF_POWER = 45;
export const FIELD_FIRST_LO_FREQUENCY = 34;
export const FIELD_FE_LOW_EDGE = 100;
export const FIELD_FE_HIGH_EDGE = 101;
export const FIELD_FE_ISREAL = 102;
export const FIELD_OUTPUT_SAMPRATE = 20;
export const FIELD_OUTPUT_CHANNELS = 49;
export const FIELD_OUTPUT_ENCODING = 107;

/**
 * Returns a Map of field_id -> Uint8Array for every TLV field in this
 * frame's Channel Data payload, or null if this frame isn't Channel Data.
 * `frame` must be an ArrayBuffer (as delivered by WebSocket onmessage for
 * binary frames).
 */
export function decodeChannelDataFields(frame) {
  if (frame.byteLength < 12) return null;
  const view = new DataView(frame);
  const word0 = view.getUint32(0, false);
  const pktType = (word0 >> 16) & 0x7f;
  if (pktType !== CHANNEL_DATA_TYPE) return null;
  const cc = (word0 >> 24) & 0x0f;
  let i = 12 + cc * 4;
  const fields = new Map();
  const bytes = new Uint8Array(frame);
  while (i + 2 <= bytes.length) {
    const fieldType = bytes[i];
    const length = bytes[i + 1];
    i += 2;
    if (i + length > bytes.length) break;
    fields.set(fieldType, bytes.slice(i, i + length));
    i += length;
  }
  return fields;
}

/** Merges fields from every Channel Data frame in a list (later frames
 * win), since a single connection's fields can arrive split across packets. */
export function mergeChannelDataFields(frames) {
  const merged = new Map();
  for (const frame of frames) {
    const fields = decodeChannelDataFields(frame);
    if (fields) for (const [k, v] of fields) merged.set(k, v);
  }
  return merged;
}

function leftPad(bytes, width) {
  const out = new Uint8Array(width);
  out.set(bytes, width - bytes.length);
  return out;
}

export function asFloat64(bytes) {
  if (!bytes || bytes.length > 8) return null;
  const padded = leftPad(bytes, 8);
  return new DataView(padded.buffer).getFloat64(0, false);
}

export function asFloat32(bytes) {
  if (!bytes || bytes.length > 4) return null;
  const padded = leftPad(bytes, 4);
  return new DataView(padded.buffer).getFloat32(0, false);
}

export function asUint(bytes) {
  if (!bytes) return 0;
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

export function asBool(bytes) {
  return asUint(bytes) !== 0;
}

export function asText(bytes) {
  if (!bytes || bytes.length === 0) return "";
  return new TextDecoder("utf-8").decode(bytes);
}

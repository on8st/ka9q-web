// Decoder for ka9q-web's audio WS frames. Audio, Channel Data (0x7E), and
// Spectrum Data (0x7F) share one RTP-style header (see spectrum-decode.js/
// status-decode.js), but audio has no TLV/fixed-record payload of its own -
// the RTP payload-type BYTE itself carries the codec and, for PCM, the
// sample rate/channel count. Ported from html/radio.js's audio switch
// (PT range 0x6F-0x7D) - see INSTRUMENT-DECISIONS.md for the audio port.
export const OPUS_PT = 0x6f;

// PT -> {sampleRate, channels} hint for PCM types. Only a hint: the
// authoritative values come from the backend's own OUTPUT_SAMPRATE/
// OUTPUT_CHANNELS Channel Data TLV fields (status-decode.js), which must
// be preferred once seen - radio.js's own comment on this: "do not guess
// the channel layout from the GUI mode... ISB/user1 needs the backend-
// reported stereo configuration" (same reasoning applies to this PT hint).
export const PCM_PT_HINTS = {
  0x70: { sampleRate: 48000, channels: 1 },
  0x71: { sampleRate: 48000, channels: 2 },
  0x74: { sampleRate: 24000, channels: 1 },
  0x75: { sampleRate: 24000, channels: 2 },
  0x77: { sampleRate: 16000, channels: 1 },
  0x78: { sampleRate: 16000, channels: 2 },
  0x7a: { sampleRate: 12000, channels: 1 },
  0x7b: { sampleRate: 12000, channels: 2 },
  0x7d: { sampleRate: 8000, channels: 1 },
};

/**
 * Returns null if `frame` isn't a recognised audio packet (Channel Data,
 * Spectrum Data, or anything else land here as null too - a frame is only
 * audio if its PT byte is Opus or a known PCM combination). Otherwise
 * { encoding: "opus"|"pcm", ptHint, payload }. For PCM, payload is already
 * byte-swapped from wire S16BE to native-endian bytes, ready to hand
 * straight to PCMPlayer.feed() (ported byte-swap: html/radio.js's audio
 * switch, S16BE case).
 */
export function decodeAudioFrame(frame) {
  if (frame.byteLength < 12) return null;
  const view = new DataView(frame);
  const word0 = view.getUint32(0, false);
  const cc = (word0 >> 24) & 0x0f;
  const type = (word0 >> 16) & 0x7f;
  const isOpus = type === OPUS_PT;
  const ptHint = PCM_PT_HINTS[type] || null;
  if (!isOpus && !ptHint) return null;

  const i = 12 + cc * 4;
  if (i > frame.byteLength) return null;

  if (isOpus) {
    return { encoding: "opus", ptHint: null, payload: new Uint8Array(frame, i, frame.byteLength - i) };
  }
  const byteLength = frame.byteLength - i;
  const raw = new Uint8Array(frame, i, byteLength);
  const swapped = new Uint8Array(byteLength);
  for (let k = 0; k + 1 < byteLength; k += 2) {
    swapped[k] = raw[k + 1];
    swapped[k + 1] = raw[k];
  }
  return { encoding: "pcm", ptHint, payload: swapped };
}

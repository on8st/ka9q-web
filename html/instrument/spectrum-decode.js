// Decoder for ka9q-web's SPECTRUM DATA (0x7F) binary WebSocket packets.
// Byte layout fully documented and confirmed against real captured
// traffic in PROTOCOL-SPECTRUM.md - read that before changing this.
export const SPECTRUM_DATA_TYPE = 0x7f;
const HEADER_SIZE = 92; // fixed record size after the RTP header, before bin bytes

/**
 * Returns null if `frame` isn't a Spectrum Data packet or is too short to
 * contain its own declared bin count (truncated/corrupt - never draw a
 * partial/misaligned spectrum).
 */
export function decodeSpectrumFrame(frame) {
  if (frame.byteLength < 12) return null;
  const view = new DataView(frame);
  const word0 = view.getUint32(0, false);
  if (((word0 >> 16) & 0x7f) !== SPECTRUM_DATA_TYPE) return null;
  const cc = (word0 >> 24) & 0x0f;
  let i = 12 + cc * 4;
  if (i + HEADER_SIZE > frame.byteLength) return null;

  // First 16 bytes big-endian, everything after little-endian - confirmed
  // against real data in PROTOCOL-SPECTRUM.md, not a stylistic assumption.
  const binCount = view.getUint32(i, false); i += 4;
  const centerHz = view.getUint32(i, false); i += 4;
  const frequencyHz = view.getUint32(i, false); i += 4;
  const binWidthHz = view.getUint32(i, false); i += 4;

  const inputSamprate = view.getUint32(i, true); i += 4;
  i += 4; // rf_agc, not surfaced yet
  i += 8; // input_samples, not surfaced yet
  const adOver = Number(view.getBigUint64(i, true)); i += 8;
  i += 8; // samples_since_over, not surfaced yet
  i += 8; // gps_time, not surfaced yet (ns since GPS epoch - needs leap-second handling to be meaningful)
  const noiseBwHz = view.getFloat32(i, true); i += 4;
  const rfAttenDb = view.getFloat32(i, true); i += 4;
  const rfGainDb = view.getFloat32(i, true); i += 4;
  i += 4; // rf_level_cal, not surfaced yet
  const ifPowerDb = view.getFloat32(i, true); i += 4;
  i += 4; // noise_density_audio
  const zoomLevel = view.getUint32(i, true); i += 4;
  const binsAutorangeOffset = view.getFloat32(i, true); i += 4;
  const binsAutorangeGain = view.getFloat32(i, true); i += 4;

  if (i + binCount > frame.byteLength) return null;
  const rawBins = new Uint8Array(frame, i, binCount);
  const gain = binsAutorangeGain !== 0 ? binsAutorangeGain : 0.5; // radiod's init_chan default
  const binsDb = new Float32Array(binCount);
  for (let k = 0; k < binCount; k++) binsDb[k] = binsAutorangeOffset + gain * rawBins[k];

  return { binCount, centerHz, frequencyHz, binWidthHz, inputSamprate, ifPowerDb, zoomLevel, binsDb, adOver, noiseBwHz, rfAttenDb, rfGainDb };
}

// NOTE: centerHz in the packet is already absolute RF Hz (sp->
// center_frequency, server-side) - it does NOT need FIRST_LO_FREQUENCY
// added on top. A function here once did that (absoluteCenterHz(),
// removed) based on an incorrect early reading of the wire format,
// masked for HF (whose own front-end LO happens to be ~0 Hz) until a
// live report on VHF/UHF (non-zero LO) surfaced it as a doubled centre
// frequency. See PROTOCOL-SPECTRUM.md for the full correction and
// ka9q-web.c's session-init comment for the server-side half of this.

// Port of tests/test_vhf_uhf_frontend_regression.py's field-level assertions,
// for the JS decoder the instrument UI actually ships (html/
// status-decode.js). Same fixtures, same facts - this proves the JS port is
// correct against the same real captured traffic, not just "looks similar
// to the Python one." Uses Node's built-in test runner - no npm dependency,
// consistent with this project's no-build-step convention for what ships.
//
// Run (containerized, host has no Node): from the repo root,
//   docker run --rm -v "$PWD:/work" -w /work node:20 \
//     node --test tests/js/status-decode.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  FIELD_DESCRIPTION,
  FIELD_FE_HIGH_EDGE,
  FIELD_FE_ISREAL,
  FIELD_FE_LOW_EDGE,
  FIELD_FIRST_LO_FREQUENCY,
  asBool,
  asFloat32,
  asFloat64,
  asText,
  mergeChannelDataFields,
} from "../../html/status-decode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "..", "fixtures");

function readFrames(fixtureName) {
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

function fieldsFor(fixtureName) {
  return mergeChannelDataFields(readFrames(fixtureName));
}

test("VHF forwards frontend fields and is a complex/IQ front end in the 2m band", () => {
  const fields = fieldsFor("vhf.bin");
  for (const f of [FIELD_FIRST_LO_FREQUENCY, FIELD_FE_ISREAL, FIELD_FE_LOW_EDGE, FIELD_FE_HIGH_EDGE]) {
    assert.ok(fields.has(f), `field ${f} missing from VHF capture`);
  }
  const freqHz = asFloat64(fields.get(FIELD_FIRST_LO_FREQUENCY));
  assert.ok(freqHz > 144_000_000 && freqHz < 148_000_000, `VHF frontend freq ${freqHz} not in 2m band`);
  assert.equal(asBool(fields.get(FIELD_FE_ISREAL)), false);
  const lo = asFloat32(fields.get(FIELD_FE_LOW_EDGE));
  const hi = asFloat32(fields.get(FIELD_FE_HIGH_EDGE));
  assert.ok(lo < 0 && hi > 0, "VHF IF window should straddle 0 (complex/IQ)");
});

test("UHF is a real-sampling front end, asymmetric window, in the 70cm band", () => {
  const fields = fieldsFor("uhf.bin");
  const freqHz = asFloat64(fields.get(FIELD_FIRST_LO_FREQUENCY));
  assert.ok(freqHz > 420_000_000 && freqHz < 450_000_000, `UHF frontend freq ${freqHz} not in 70cm band`);
  assert.equal(asBool(fields.get(FIELD_FE_ISREAL)), true);
  const lo = asFloat32(fields.get(FIELD_FE_LOW_EDGE));
  const hi = asFloat32(fields.get(FIELD_FE_HIGH_EDGE));
  assert.ok(lo < 0 && hi < 0 && lo < hi, "UHF IF window should be entirely negative (real-sampling)");
});

test("HF frontend frequency stays near zero (direct sampling, unaffected)", () => {
  const fields = fieldsFor("hf.bin");
  const freqHz = fields.has(FIELD_FIRST_LO_FREQUENCY) ? asFloat64(fields.get(FIELD_FIRST_LO_FREQUENCY)) : 0;
  assert.ok(Math.abs(freqHz) < 1_000_000);
});

test("DESCRIPTION field decodes as readable front-end text", () => {
  const vhf = fieldsFor("vhf.bin");
  const uhf = fieldsFor("uhf.bin");
  assert.equal(asText(vhf.get(FIELD_DESCRIPTION)), "2m - RTL-SDR");
  assert.equal(asText(uhf.get(FIELD_DESCRIPTION)), "70cm - Airspy R2");
});

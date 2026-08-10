#!/usr/bin/env node
// Mechanical parity check - the brief's own words: "demonstrable by a
// check that runs, not asserted in a commit message." Run:
//   node tests/check-parity.mjs
// Exits non-zero if the manifest itself has drifted from reality (a
// claimed stock or instrument id no longer exists anywhere) - that's a
// bug in the manifest, not a parity gap, and is distinct from a feature
// honestly marked `instrumentId: null` (not yet built).
//
// What this proves: a corresponding UI element/affordance *exists* for
// each stock feature. It does NOT prove full behavioural equivalence
// (that a click on it does the same thing) - see each feature's own
// commit for the live-behaviour verification that happened when it was
// built. This is the "is it reachable at all" layer of the two.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PARITY_MANIFEST } from "./parity-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function idsIn(text) {
  const ids = new Set();
  // HTML-attribute style (id="x") and JS property-assignment style
  // (el.id = "x", used for elements created dynamically at runtime -
  // e.g. freq-digits.js's double-click-to-type input).
  for (const m of text.matchAll(/\bid=["']([a-zA-Z0-9_-]+)["']/g)) ids.add(m[1]);
  for (const m of text.matchAll(/\.id\s*=\s*["']([a-zA-Z0-9_-]+)["']/g)) ids.add(m[1]);
  return ids;
}

function walk(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const stockText = readFileSync(join(ROOT, "html/radio.html"), "utf8") + readFileSync(join(ROOT, "html/optionsDialog.html"), "utf8");
const stockIds = idsIn(stockText);

const instrumentFiles = walk(join(ROOT, "html/instrument"), [".html", ".js"]);
const instrumentIds = new Set();
for (const f of instrumentFiles) idsIn(readFileSync(f, "utf8")).forEach((id) => instrumentIds.add(id));

let manifestErrors = 0;
let built = 0;
let notBuilt = 0;

console.log("Parity check - stock ka9q-web features vs. the instrument UI\n");

for (const entry of PARITY_MANIFEST) {
  const missingStockIds = entry.stockIds.filter((id) => !stockIds.has(id));
  if (missingStockIds.length > 0) {
    console.log(`✗ MANIFEST ERROR: "${entry.feature}" claims stock id(s) [${missingStockIds.join(", ")}] that don't exist in html/radio.html or html/optionsDialog.html - manifest has drifted from reality.`);
    manifestErrors++;
    continue;
  }
  if (entry.instrumentId === null) {
    console.log(`○ NOT YET BUILT: ${entry.feature}`);
    notBuilt++;
    continue;
  }
  if (!instrumentIds.has(entry.instrumentId)) {
    console.log(`✗ MANIFEST ERROR: "${entry.feature}" claims instrument id "${entry.instrumentId}" that doesn't exist anywhere under html/instrument/ - manifest has drifted from reality.`);
    manifestErrors++;
    continue;
  }
  console.log(`✓ built: ${entry.feature} (${entry.instrumentId})`);
  built++;
}

console.log(`\n${built} built, ${notBuilt} not yet built, ${manifestErrors} manifest errors, ${PARITY_MANIFEST.length} features total.`);
if (manifestErrors > 0) {
  console.log("\nFAILED: manifest errors mean this check can no longer be trusted until fixed.");
  process.exit(1);
}
console.log(`\n${notBuilt} feature(s) remain honestly unbuilt - this is the real, current parity gap, not a hidden one.`);

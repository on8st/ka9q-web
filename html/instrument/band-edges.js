// "Show ham band edge markers" - a low/high-edge table, distinct from
// band-options.js's BAND_OPTIONS (single center frequencies for the
// quick-select chips - no edges, missing several bands, and collapses
// the five separate 60m channel sub-bands into one). Ported verbatim
// from spectrum.js's getHamBands() (values there in MHz; here in Hz to
// match this fork's convention of working in Hz throughout).
export const HAM_BAND_EDGES = [
  { lowHz: 135_700, highHz: 137_800, label: "2200m" },
  { lowHz: 472_000, highHz: 479_000, label: "630m" },
  { lowHz: 1_800_000, highHz: 2_000_000, label: "160m" },
  { lowHz: 3_500_000, highHz: 4_000_000, label: "80m" },
  { lowHz: 5_330_600, highHz: 5_333_400, label: "60m ch1" },
  { lowHz: 5_346_600, highHz: 5_349_400, label: "60m ch2" },
  { lowHz: 5_351_500, highHz: 5_366_500, label: "60m qrp" },
  { lowHz: 5_371_600, highHz: 5_374_400, label: "60m ch4" },
  { lowHz: 5_403_600, highHz: 5_406_400, label: "60m ch5" },
  { lowHz: 7_000_000, highHz: 7_300_000, label: "40m" },
  { lowHz: 10_100_000, highHz: 10_150_000, label: "30m" },
  { lowHz: 14_000_000, highHz: 14_350_000, label: "20m" },
  { lowHz: 18_068_000, highHz: 18_168_000, label: "17m" },
  { lowHz: 21_000_000, highHz: 21_450_000, label: "15m" },
  { lowHz: 24_890_000, highHz: 24_990_000, label: "12m" },
  { lowHz: 26_960_000, highHz: 27_410_000, label: "11m CB" },
  { lowHz: 28_000_000, highHz: 29_700_000, label: "10m" },
  { lowHz: 50_000_000, highHz: 54_000_000, label: "6m" },
  { lowHz: 144_000_000, highHz: 148_000_000, label: "2m" },
  { lowHz: 222_000_000, highHz: 225_000_000, label: "125cm" },
  { lowHz: 420_000_000, highHz: 450_000_000, label: "70cm" },
  { lowHz: 1_240_000_000, highHz: 1_300_000_000, label: "23cm" },
];

/** Which bands overlap the given displayed span at all - the only ones
 * worth drawing markers for. */
export function bandEdgesInSpan(lowHz, highHz) {
  return HAM_BAND_EDGES.filter((b) => b.highHz >= lowHz && b.lowHz <= highHz);
}

/** Which single band the tuned frequency falls inside, if any - drives
 * the BAND segment's label. Returns null when the frequency isn't inside
 * any known ham band (e.g. HF's WWV/broadcast defaults, or a receiver
 * whose coverage doesn't line up with a specific allocation) - the
 * caller falls back to a generic "Full band" label in that case. */
export function bandForFrequency(hz) {
  return HAM_BAND_EDGES.find((b) => hz >= b.lowHz && hz <= b.highHz) || null;
}

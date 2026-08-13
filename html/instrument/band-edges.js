// "Show ham band edge markers" - a low/high-edge table, distinct from
// band-options.js's BAND_OPTIONS (single center frequencies for the
// quick-select chips - no edges, missing several bands, and collapses
// the five separate 60m channel sub-bands into one). Originally ported
// verbatim from stock's spectrum.js getHamBands() - which turned out to
// be an IARU Region 2 (Americas) band plan, wrong for this station
// (ON8ST, Belgium, IARU Region 1). Reported live 2026-08-13 ("why
// doesn't the 2m band zoom from 144 to 146" - Region 1's 2m is
// 144.000-146.000 MHz, not Region 2's 144.000-148.000). This table
// feeds bandForFrequency() directly, so the wrong edges affected more
// than just the drawn markers: the BAND label, mode-by-frequency
// detection, AZC-on-tune, the band chips' own zoom-to-fit width, and
// the wheel zoom-out band cap (issue captured live: VHF's cap never
// actually bound against the real 4MHz-wide Region-2 "2m" entry, only
// against the receiver's own narrower real coverage, coincidentally).
// Region 1 edges below confirmed against well-established, unambiguous
// IARU distinctions (2200m/630m/160m and the WARC bands 30m/20m/17m/
// 15m/12m are the same worldwide, so those needed no change). 60m and
// 6m are NOT changed here - both vary significantly by country/WRC
// cycle even within Region 1 (60m in particular: these five channel
// centers match the *US* 60m channelization exactly, not Belgium's -
// deliberately left as a known-uncertain TODO rather than guessed at,
// pending a real source (BIPT's current allocation table) instead of
// assumption.
export const HAM_BAND_EDGES = [
  { lowHz: 135_700, highHz: 137_800, label: "2200m" },
  { lowHz: 472_000, highHz: 479_000, label: "630m" },
  { lowHz: 1_800_000, highHz: 2_000_000, label: "160m" },
  { lowHz: 3_500_000, highHz: 3_800_000, label: "80m" }, // Region 1: 3500-3800 (was 3500-4000, Region 2)
  { lowHz: 5_330_600, highHz: 5_333_400, label: "60m ch1" }, // TODO: US channelization, not verified for Belgium
  { lowHz: 5_346_600, highHz: 5_349_400, label: "60m ch2" }, // TODO: US channelization, not verified for Belgium
  { lowHz: 5_351_500, highHz: 5_366_500, label: "60m qrp" }, // TODO: US channelization, not verified for Belgium
  { lowHz: 5_371_600, highHz: 5_374_400, label: "60m ch4" }, // TODO: US channelization, not verified for Belgium
  { lowHz: 5_403_600, highHz: 5_406_400, label: "60m ch5" }, // TODO: US channelization, not verified for Belgium
  { lowHz: 7_000_000, highHz: 7_200_000, label: "40m" }, // Region 1: 7000-7200 (was 7000-7300, Region 2)
  { lowHz: 10_100_000, highHz: 10_150_000, label: "30m" },
  { lowHz: 14_000_000, highHz: 14_350_000, label: "20m" },
  { lowHz: 18_068_000, highHz: 18_168_000, label: "17m" },
  { lowHz: 21_000_000, highHz: 21_450_000, label: "15m" },
  { lowHz: 24_890_000, highHz: 24_990_000, label: "12m" },
  { lowHz: 26_960_000, highHz: 27_410_000, label: "11m CB" },
  { lowHz: 28_000_000, highHz: 29_700_000, label: "10m" },
  { lowHz: 50_000_000, highHz: 54_000_000, label: "6m" }, // TODO: US allocation (50-54MHz), not verified for Belgium's actual current limit
  { lowHz: 144_000_000, highHz: 146_000_000, label: "2m" }, // Region 1: 144-146 (was 144-148, Region 2) - the reported bug
  { lowHz: 430_000_000, highHz: 440_000_000, label: "70cm" }, // Region 1: 430-440 (was 420-450, Region 2)
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

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
// 15m/12m are the same worldwide, so those needed no change). 60m/6m/4m
// are Belgium-specific national allocations (not IARU-wide), confirmed
// 2026-08-13 against UBA's own published tables (uba.be/nl/info/
// frequentie-vermogens and uba.be/.../bandplanning-between-50-and-54-mhz,
// the national society's own numbers - not guessed at, and not the
// *US* 60m channelization this table originally, wrongly, carried):
// - 60m: Belgium's actual allocation is a single 5351.5-5366.5kHz
//   secondary segment (Class A only, 15W ERP) - it only ever matched
//   *one* of the five US channels ("60m qrp") by coincidence; the other
//   four were pure US channelization with no Belgian equivalent, removed.
// - 6m: UBA confirms Belgium is capped at 50-52MHz secondary (52-54MHz
//   "NOT AUTORIZED IN BELGIUM" per UBA's own bandplan doc) - narrower
//   than the US-wide 50-54MHz this entry previously carried.
// - 4m: added new, Belgium-only (no Region 2 equivalent existed to carry
//   over). UBA lists two disjoint segments - a 10kHz-wide single-carrier
//   slice at 69.95MHz (10W EIRP) and the main 70.1125-70.4125MHz segment
//   (50W) - only the main segment is represented here; the 69.95MHz
//   sliver is a beacon/experimental channel, not a tunable band, so
//   doesn't fit this table's low/high-edge shape.
// 6m and 4m are both above the RX888 front end's current direct-sampling
// HF configuration (Nyquist per config/radiod@rx888-web.conf's rx888
// samprate) - added for completeness (BAND label, markers) even though
// this receiver can't currently tune into either.
//
// html/legacy/spectrum.js's Spectrum.prototype.getHamBands() is a literal
// duplicate of this table (MHz instead of Hz, otherwise the same data) -
// it was ported from the same wrong stock source and initially missed
// when this table got fixed, so it kept shipping the Region 2 edges here
// for another day (fixed 2026-08-14). Nothing ties the two together;
// update both if you change a band edge here.
export const HAM_BAND_EDGES = [
  { lowHz: 135_700, highHz: 137_800, label: "2200m" },
  { lowHz: 472_000, highHz: 479_000, label: "630m" },
  { lowHz: 1_800_000, highHz: 2_000_000, label: "160m" },
  { lowHz: 3_500_000, highHz: 3_800_000, label: "80m" }, // Region 1: 3500-3800 (was 3500-4000, Region 2)
  { lowHz: 5_351_500, highHz: 5_366_500, label: "60m" }, // Belgium (UBA): single secondary segment, Class A only, 15W ERP
  { lowHz: 7_000_000, highHz: 7_200_000, label: "40m" }, // Region 1: 7000-7200 (was 7000-7300, Region 2)
  { lowHz: 10_100_000, highHz: 10_150_000, label: "30m" },
  { lowHz: 14_000_000, highHz: 14_350_000, label: "20m" },
  { lowHz: 18_068_000, highHz: 18_168_000, label: "17m" },
  { lowHz: 21_000_000, highHz: 21_450_000, label: "15m" },
  { lowHz: 24_890_000, highHz: 24_990_000, label: "12m" },
  { lowHz: 26_960_000, highHz: 27_410_000, label: "11m CB" },
  { lowHz: 28_000_000, highHz: 29_700_000, label: "10m" },
  { lowHz: 50_000_000, highHz: 52_000_000, label: "6m" }, // Belgium (UBA): capped at 50-52MHz, 52-54MHz not authorized - outside current RX888 HF coverage
  { lowHz: 70_112_500, highHz: 70_412_500, label: "4m" }, // Belgium (UBA): main secondary segment, 50W - outside current RX888 HF coverage
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

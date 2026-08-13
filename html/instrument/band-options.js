// Ported directly from html/radio.js's own bandOptions - not reinvented -
// including this fork's own 2m/70cm additions (frequency-offset commit).
// Keep in sync with that file if it ever changes.
//
// 60M was radio.js's own five US-channelized entries (60Mch1..60Mch5) -
// same error as band-edges.js originally carried (see that file's header
// comment). Collapsed 2026-08-13 to a single chip at 5359000Hz, the
// centre of Belgium's actual UBA-confirmed 5351.5-5366.5kHz secondary
// segment - matching band-edges.js's own consolidation in the same
// change, so the quick-select chip and the edge markers/BAND label agree.
export const BAND_OPTIONS = {
  amateur: [
    { label: "2200M", freq: 136750 },
    { label: "630M", freq: 475500 },
    { label: "160M", freq: 1900000 },
    { label: "80M", freq: 3715000 },
    { label: "60M", freq: 5359000 },
    { label: "40M", freq: 7150000 },
    { label: "30M", freq: 10125000 },
    { label: "20M", freq: 14185000 },
    { label: "17M", freq: 18110000 },
    { label: "15M", freq: 21300000 },
    { label: "12M", freq: 24930000 },
    { label: "10M", freq: 28500000 },
    { label: "6M", freq: 50100000 },
    { label: "2M", freq: 145500000 },
    { label: "70CM", freq: 433500000 },
  ],
  broadcast: [
    { label: "120M", freq: 2397500 },
    { label: "90M", freq: 3300000 },
    { label: "75M", freq: 3950000 },
    { label: "60M", freq: 4905000 },
    { label: "49M", freq: 6050000 },
    { label: "41M", freq: 7375000 },
    { label: "31M", freq: 9650000 },
    { label: "25M", freq: 11850000 },
    { label: "22M", freq: 13720000 },
    { label: "19M", freq: 15450000 },
    { label: "16M", freq: 17690000 },
    { label: "15M", freq: 18960000 },
    { label: "13M", freq: 21650000 },
    { label: "11M", freq: 25850000 },
  ],
  utility: [
    { label: "WWV2.5", freq: 2500000 },
    { label: "WWV5", freq: 5000000 },
    { label: "WWV10", freq: 10000000 },
    { label: "WWV15", freq: 15000000 },
    { label: "WWV20", freq: 20000000 },
    { label: "WWV25", freq: 25000000 },
  ],
};

/**
 * Band chips only make sense if this receiver can actually reach them - a
 * VHF-only receiver showing "40M" is a dead end, not a shortcut. Not
 * prescribed by the design brief; a deliberate adaptation to instruments
 * that (unlike the stock all-bands UI) each cover only one slice of
 * spectrum. Returns [] if nothing in a category is reachable, so the
 * caller can skip rendering that category entirely.
 */
export function bandsInCoverage(category, lowHz, highHz) {
  return (BAND_OPTIONS[category] || []).filter((b) => b.freq >= lowHz && b.freq <= highHz);
}

// "Status-bar frequency display" in the parity manifest names stock's
// `cksbFrequency` checkbox - which is actually mislabeled there too: its
// real id/behaviour is "Switch Modes by Frequency" (its own tooltip:
// "Switch modes to LSB/USB by frequency < or > than 10 MHz"), an
// HF-band auto-mode-select on programmatic tuning, not a display toggle
// at all. Ported what it actually does. Table and thresholds copied
// verbatim from radio.js's setModeBasedOnFrequencyIfAllowed().
export function modeForFrequency(hz) {
  if (hz >= 30_000_000) return null; // never touches VHF/UHF
  if (hz === 2_500_000 || hz === 5_000_000 || hz === 10_000_000 || hz === 15_000_000 || hz === 20_000_000 || hz === 25_000_000) return "am"; // WWV/WWVH
  if (hz === 3_330_000 || hz === 7_850_000) return "usb"; // CHU
  if (hz >= 5_330_500 && hz < 5_406_500) return "usb"; // 60m
  if (hz >= 26_960_000 && hz < 27_360_000) return "am"; // CB
  if (hz >= 27_360_000 && hz < 27_410_000) return "lsb"; // CB extension
  if (hz >= 1_810_000 && hz < 2_000_000) return "lsb"; // 160m
  if (hz >= 3_500_000 && hz < 3_800_000) return "lsb"; // 80m
  if (hz >= 7_000_000 && hz < 7_200_000) return "lsb"; // 40m
  if (hz >= 10_100_000 && hz < 10_150_000) return "cwu"; // 30m
  if (hz >= 14_000_000 && hz < 14_350_000) return "usb"; // 20m
  if (hz >= 18_068_000 && hz < 18_168_000) return "usb"; // 17m
  if (hz >= 21_000_000 && hz < 21_450_000) return "usb"; // 15m
  if (hz >= 24_890_000 && hz < 24_990_000) return "usb"; // 12m
  if (hz >= 28_000_000 && hz < 29_700_000) return "usb"; // 10m
  if (hz < 10_000_000) return "lsb"; // catch-all below the 10MHz line
  return "usb"; // catch-all at/above the 10MHz line
}

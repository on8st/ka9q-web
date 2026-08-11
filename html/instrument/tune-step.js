// "The step is visible, not hidden. It sits beside the frequency with an
// up and a down control, tuning by the amount shown. Choosing a different
// step happens on the step itself." (design brief section 4)

// Exactly the stock step options from html/radio.html's own <select> -
// not invented.
export const STEP_OPTIONS_HZ = [1, 10, 100, 250, 500, 1000, 5000, 9000, 10000, 100000, 1000000];

export function applyStep(currentHz, stepHz, direction) {
  return Math.max(0, Math.round(currentHz) + direction * stepHz);
}

export function fmtStep(hz) {
  if (hz < 1000) return `${hz} Hz`;
  if (hz < 1_000_000) return `${hz / 1000} kHz`;
  return `${hz / 1_000_000} MHz`;
}

// "Alternate frequency buttons" (stock: alternate_freq_buttons, labelled
// "Alt") - another manifest-name misnomer: it's a fixed-step override for
// the nudge buttons plus a round-to-nearest-kHz on manual entry, not a
// display-format toggle. Stock has two button pairs (outer ±100Hz, inner
// ±10Hz); this UI has one step pair, so ported as the inner pair's fixed
// target (10Hz) - the more precise, more generally useful of the two.
export const ALT_STEP_HZ = 10;

export function roundToNearestKhz(hz) {
  return Math.round(hz / 1000) * 1000;
}

// Click-to-tune in the spectrum should land on the same grid the step
// up/down buttons walk, not on the exact (sub-Hz) pixel the user clicked.
export function snapToStep(hz, stepHz) {
  if (!stepHz) return Math.round(hz);
  return Math.round(hz / stepHz) * stepHz;
}

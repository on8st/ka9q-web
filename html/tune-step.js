// "The step is visible, not hidden. It sits beside the frequency with an
// up and a down control, tuning by the amount shown. Choosing a different
// step happens on the step itself." (design brief section 4)

// Exactly the stock step options from html/legacy/radio.html's own
// <select> - not invented.
export const STEP_OPTIONS_HZ = [1, 10, 100, 250, 500, 1000, 5000, 9000, 10000, 100000, 1000000];

// Steps to the next/previous point on the step grid, not a raw addition -
// e.g. 145.333 MHz stepping up by 10 kHz gives 145.340 MHz, not 145.343
// MHz: digits below the step's own significance are zeroed rather than
// carried through. If currentHz is already exactly on the grid, this
// still moves a full step (doesn't re-land on the same point).
export function applyStep(currentHz, stepHz, direction) {
  const hz = Math.round(currentHz);
  const grid = direction > 0
    ? (Math.floor(hz / stepHz) + 1) * stepHz
    : (Math.ceil(hz / stepHz) - 1) * stepHz;
  return Math.max(0, grid);
}

export function fmtStep(hz) {
  if (hz < 1000) return `${hz} Hz`;
  if (hz < 1_000_000) return `${hz / 1000} kHz`;
  return `${hz / 1_000_000} MHz`;
}

// Click-to-tune in the spectrum should land on the same grid the step
// up/down buttons walk, not on the exact (sub-Hz) pixel the user clicked.
export function snapToStep(hz, stepHz) {
  if (!stepHz) return Math.round(hz);
  return Math.round(hz / stepHz) * stepHz;
}

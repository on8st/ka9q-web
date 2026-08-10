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

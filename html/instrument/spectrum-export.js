// Export the currently displayed spectrum as CSV (Hz, dB per row) - part
// of the brief's "rare things" panel (telemetry, behaviour, export, notes).
export function spectrumToCsv(spectrum, absCenterHz) {
  const { binsDb, binWidthHz, binCount } = spectrum;
  const startHz = absCenterHz - (binWidthHz * binCount) / 2;
  const lines = ["hz,db"];
  for (let i = 0; i < binsDb.length; i++) {
    lines.push(`${Math.round(startHz + i * binWidthHz)},${binsDb[i].toFixed(2)}`);
  }
  return lines.join("\n");
}

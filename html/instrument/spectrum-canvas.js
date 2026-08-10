// Live spectrum trace + waterfall, filling #display-area per the design
// brief ("the receiver fills the screen... nothing floats over them").
// The mockup's own canvas painting is explicitly throwaway (brief section
// 2) - this is a fresh implementation, not a port of spectrum.js.

// A simple 5-stop black -> blue -> cyan -> yellow -> red heatmap. Not
// perceptually-uniform (viridis/turbo would be), but exact, easy-to-verify
// arithmetic beats an imported palette table for a first working version.
const HEATMAP_STOPS = [
  [0, 0, 0],
  [0, 0, 180],
  [0, 200, 200],
  [230, 230, 0],
  [230, 0, 0],
];

export function dbToColor(db, minDb, maxDb) {
  const t = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
  const scaled = t * (HEATMAP_STOPS.length - 1);
  const i = Math.min(HEATMAP_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - i;
  const [r0, g0, b0] = HEATMAP_STOPS[i];
  const [r1, g1, b1] = HEATMAP_STOPS[i + 1];
  return [
    Math.round(r0 + (r1 - r0) * frac),
    Math.round(g0 + (g1 - g0) * frac),
    Math.round(b0 + (b1 - b0) * frac),
  ];
}

/** Which bin index a pixel column maps to, for a canvas `width` px wide
 * showing `binCount` bins. Floors rather than rounds so every pixel maps
 * to exactly one bin with no gaps at the edges. */
export function binIndexForPixel(x, width, binCount) {
  return Math.min(binCount - 1, Math.max(0, Math.floor((x / width) * binCount)));
}

/** hz shown at a given pixel column, given the absolute (already
 * FIRST_LO_FREQUENCY-corrected - see spectrum-decode.js) centre. */
export function hzForPixel(x, width, absCenterHz, binWidthHz, binCount) {
  const spanHz = binWidthHz * binCount;
  const startHz = absCenterHz - spanHz / 2;
  return startHz + (x / width) * spanHz;
}

export function createSpectrumDisplay(container) {
  container.innerHTML = "";
  container.classList.add("spectrum-display");
  const traceCanvas = document.createElement("canvas");
  const waterfallCanvas = document.createElement("canvas");
  traceCanvas.className = "spectrum-trace";
  waterfallCanvas.className = "spectrum-waterfall";
  container.appendChild(traceCanvas);
  container.appendChild(waterfallCanvas);

  const TRACE_FRACTION = 0.35;

  function resize() {
    const rect = container.getBoundingClientRect();
    traceCanvas.width = Math.max(1, Math.round(rect.width));
    traceCanvas.height = Math.max(1, Math.round(rect.height * TRACE_FRACTION));
    waterfallCanvas.width = Math.max(1, Math.round(rect.width));
    waterfallCanvas.height = Math.max(1, Math.round(rect.height * (1 - TRACE_FRACTION)));
  }
  resize();
  // A window resize isn't the only thing that changes this container's
  // size - #control-block's own content (chips, switcher) loads
  // asynchronously and can shrink #display-area without the window ever
  // resizing. Confirmed live: sizing once at construction left the canvas
  // taller than its actual container once real content had loaded.
  new ResizeObserver(resize).observe(container);

  const traceCtx = traceCanvas.getContext("2d");
  const waterfallCtx = waterfallCanvas.getContext("2d");
  // Reasonable defaults; the design brief leaves "display settings" (auto-
  // range, dB floor/ceiling) as a later, separate control ("reached from
  // the canvas, not the readout") - this is a fixed starting range, not a
  // protocol fact.
  let minDb = -100;
  let maxDb = -20;

  function render(spectrum) {
    const { binsDb } = spectrum;
    const w = traceCanvas.width;
    const h = traceCanvas.height;

    traceCtx.fillStyle = "#000";
    traceCtx.fillRect(0, 0, w, h);
    traceCtx.strokeStyle = "#6f6";
    traceCtx.beginPath();
    for (let x = 0; x < w; x++) {
      const db = binsDb[binIndexForPixel(x, w, binsDb.length)];
      const y = h - Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb))) * h;
      if (x === 0) traceCtx.moveTo(x, y); else traceCtx.lineTo(x, y);
    }
    traceCtx.stroke();

    const ww = waterfallCanvas.width;
    const wh = waterfallCanvas.height;
    if (wh > 1) {
      waterfallCtx.drawImage(waterfallCanvas, 0, 0, ww, wh - 1, 0, 1, ww, wh - 1);
    }
    const row = waterfallCtx.createImageData(ww, 1);
    for (let x = 0; x < ww; x++) {
      const db = binsDb[binIndexForPixel(x, ww, binsDb.length)];
      const [r, g, b] = dbToColor(db, minDb, maxDb);
      row.data[x * 4] = r;
      row.data[x * 4 + 1] = g;
      row.data[x * 4 + 2] = b;
      row.data[x * 4 + 3] = 255;
    }
    waterfallCtx.putImageData(row, 0, 0);
  }

  let paused = false;
  let lastSpectrum = null;

  function setRange(newMinDb, newMaxDb) {
    minDb = newMinDb;
    maxDb = newMaxDb;
  }

  function setPaused(value) {
    paused = value;
  }

  const originalRender = render;
  return {
    render: (spectrum) => {
      lastSpectrum = spectrum;
      if (!paused) originalRender(spectrum);
    },
    resize,
    setRange,
    getRange: () => ({ minDb, maxDb }),
    setPaused,
    isPaused: () => paused,
    getLastSpectrum: () => lastSpectrum,
    traceCanvas,
    waterfallCanvas,
  };
}

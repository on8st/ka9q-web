// "Meter style changes the readout. The choice between a bar and an
// analog meter changes what is shown in the control block itself. A
// settings panel holds the choice, never a second meter." (brief section 4)
//
// IF_POWER's real range isn't a documented protocol fact - -80..0 dB is a
// presentational choice (comfortably spans what's been observed live,
// roughly -37dB on a quiet 2m channel) picked for a readable meter, not
// read from anywhere. Adjust if real-world readings clip against it.
const MIN_DB = -80;
const MAX_DB = 0;
const MIN_NEEDLE_DEG = -60;
const MAX_NEEDLE_DEG = 60;
const STORAGE_KEY = "instrument_meter_style";

export function dbToPercent(db, minDb = MIN_DB, maxDb = MAX_DB) {
  const clamped = Math.min(maxDb, Math.max(minDb, db));
  return ((clamped - minDb) / (maxDb - minDb)) * 100;
}

export function dbToNeedleDeg(db, minDeg = MIN_NEEDLE_DEG, maxDeg = MAX_NEEDLE_DEG) {
  const pct = dbToPercent(db) / 100;
  return minDeg + pct * (maxDeg - minDeg);
}

function renderBar(container, db) {
  container.innerHTML = `<div class="meter-bar-track"><div class="meter-bar-fill" style="width:${dbToPercent(db).toFixed(1)}%"></div></div>`;
}

function renderAnalog(container, db) {
  const deg = dbToNeedleDeg(db).toFixed(1);
  container.innerHTML = `
    <svg class="meter-analog" viewBox="0 0 100 60" width="100" height="60">
      <path d="M 10 55 A 40 40 0 0 1 90 55" fill="none" stroke="#444" stroke-width="2"/>
      <line x1="50" y1="55" x2="50" y2="18" stroke="#f66" stroke-width="2"
            transform="rotate(${deg} 50 55)"/>
      <circle cx="50" cy="55" r="3" fill="#f66"/>
    </svg>`;
}

/** Manages which meter style is shown, persisted across reloads. render(db)
 * re-renders whichever style is currently selected - only one is ever in
 * the DOM at once, per the brief ("never a second meter"). */
export function createMeter(container) {
  let style = localStorage.getItem(STORAGE_KEY) || "bar";
  let lastDb = null;

  function render(db) {
    lastDb = db;
    if (db === null || db === undefined) { container.innerHTML = "—"; return; }
    (style === "analog" ? renderAnalog : renderBar)(container, db);
  }

  function setStyle(newStyle) {
    style = newStyle;
    localStorage.setItem(STORAGE_KEY, style);
    render(lastDb);
  }

  return { render, setStyle, getStyle: () => style };
}

// Minimal memory-slot feature: save the current frequency under a label,
// recall it later. Not the stock UI's full 50-slot memory system (that's
// a larger feature than "quick-select chips" implies) - functional
// parity intent (a way to save/recall frequencies exists), not a port.
const STORAGE_KEY = "instrument_memories";

export function loadMemories() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function persist(memories) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(memories));
  return memories;
}

export function addMemory(memories, freqHz, label) {
  return persist([...memories, { freqHz, label: label || defaultLabel(freqHz) }]);
}

export function deleteMemory(memories, index) {
  return persist(memories.filter((_, i) => i !== index));
}

/** Replaces the entire list (e.g. after a successful import) and
 * persists it, same as add/delete. */
export function replaceMemories(memories) {
  return persist(memories);
}

export function defaultLabel(freqHz) {
  return `${(freqHz / 1e6).toFixed(3)} MHz`;
}

// "Memory import/export as a set" - stock's format (radio.js's
// MEMORY_KEY) is a fixed 50-slot array of {freq: string-Hz, desc, mode},
// always all 50 present (empty slots are {freq:'',desc:'',mode:''}).
// This UI's own format ({freqHz: number, label}, unbounded, no mode
// field - see the module header above) is different on purpose, not an
// oversight, so export produces this UI's own native shape (round-trips
// with itself exactly) while import also accepts a genuine stock-format
// file for interop between the two UIs on the same station.
export function exportMemoriesJson(memories) {
  return JSON.stringify(memories, null, 2);
}

/** Parses a previously-exported file (either this UI's own format or a
 * genuine stock `frequency_memories` export) into this UI's memory
 * shape. Returns the parsed list, or null if the JSON doesn't look like
 * either format (caller decides how to surface that - see app.js). */
export function importMemoriesJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return [];
  const first = parsed[0];
  if (first && typeof first === "object" && "freqHz" in first) {
    // Already this UI's own format.
    return parsed.filter((m) => Number.isFinite(m.freqHz)).map((m) => ({ freqHz: m.freqHz, label: m.label || defaultLabel(m.freqHz) }));
  }
  if (first && typeof first === "object" && "freq" in first) {
    // Stock's 50-slot format - drop empty slots, translate fields.
    return parsed
      .filter((m) => m && m.freq !== "" && m.freq !== undefined && m.freq !== null && Number.isFinite(Number(m.freq)))
      .map((m) => ({ freqHz: Number(m.freq), label: m.desc || defaultLabel(Number(m.freq)) }));
  }
  return null;
}

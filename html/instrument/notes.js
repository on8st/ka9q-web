// Free-text operator notes, persisted locally. Part of the brief's
// "rare things" panel (telemetry, behaviour options, export and notes).
const STORAGE_KEY = "instrument_notes";

export function loadNotes() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch (e) {
    return "";
  }
}

export function saveNotes(text) {
  localStorage.setItem(STORAGE_KEY, text);
}

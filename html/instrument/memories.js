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

export function defaultLabel(freqHz) {
  return `${(freqHz / 1e6).toFixed(3)} MHz`;
}

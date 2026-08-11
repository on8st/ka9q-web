// Right-click context menu for the spectrum/waterfall canvas - the design
// mockup's own two-menu pattern (right-click above the trace/waterfall
// split shows one menu, below shows another), deferred until the controls
// it would host actually existed (see INSTRUMENT-DECISIONS.md). Reuses
// the same "glass" popover visual language as value-panel.js, positioned
// at the click point instead of anchored to an element - no caret, since
// there's no single anchor element to point back at.
let panelEl = null;

function close() {
  if (!panelEl) return;
  panelEl.remove();
  panelEl = null;
  document.removeEventListener("click", onOutsideClick, true);
  document.removeEventListener("keydown", onKeydown, true);
}

function onOutsideClick(e) {
  if (panelEl && !panelEl.contains(e.target)) close();
}

function onKeydown(e) {
  if (e.key === "Escape") close();
}

export function showContextMenu(x, y, buildContent) {
  close();
  panelEl = document.createElement("div");
  panelEl.className = "value-panel glass ctx-menu";
  panelEl.style.position = "absolute";
  document.body.appendChild(panelEl);
  buildContent(panelEl, close);

  const w = panelEl.offsetWidth;
  const h = panelEl.offsetHeight;
  const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  panelEl.style.left = `${window.scrollX + left}px`;
  panelEl.style.top = `${window.scrollY + top}px`;

  // Deferred so the click/contextmenu event that opened this doesn't
  // immediately close it via the same listener.
  setTimeout(() => {
    document.addEventListener("click", onOutsideClick, true);
    document.addEventListener("keydown", onKeydown, true);
  }, 0);
}

export function closeContextMenu() {
  close();
}

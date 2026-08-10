// Small reusable "anchored popover" helper for the design brief's
// recurring pattern: "Every value shown is the control for itself...
// Each opens its own purpose-built panel anchored to that value." Used
// for the mode picker now; band/memory/bandwidth will reuse it.
//
// Deliberately minimal: positions a panel below its anchor element,
// closes on an outside click or Escape, and calls onOpen()/nothing else -
// the panel's own content/behaviour is entirely up to the caller.

export function createValuePanel(anchorEl, buildContent) {
  let panelEl = null;

  function close() {
    if (!panelEl) return;
    panelEl.remove();
    panelEl = null;
    document.removeEventListener("click", onOutsideClick, true);
    document.removeEventListener("keydown", onKeydown, true);
  }

  function onOutsideClick(e) {
    if (panelEl && !panelEl.contains(e.target) && e.target !== anchorEl) close();
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  function open() {
    if (panelEl) { close(); return; }
    panelEl = document.createElement("div");
    panelEl.className = "value-panel";
    buildContent(panelEl, close);
    document.body.appendChild(panelEl);

    const anchorRect = anchorEl.getBoundingClientRect();
    panelEl.style.position = "absolute";
    panelEl.style.top = `${window.scrollY + anchorRect.bottom + 4}px`;
    panelEl.style.left = `${window.scrollX + anchorRect.left}px`;

    // Deferred so the click that opened this panel doesn't immediately
    // close it via the same listener.
    setTimeout(() => {
      document.addEventListener("click", onOutsideClick, true);
      document.addEventListener("keydown", onKeydown, true);
    }, 0);
  }

  anchorEl.classList.add("value-anchor");
  anchorEl.addEventListener("click", open);
  return { close };
}

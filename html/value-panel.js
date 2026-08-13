// Reusable anchored popover for the design brief's recurring pattern:
// "Every value shown is the control for itself... Each opens its own
// purpose-built panel anchored to that value." Positioning matches the
// approved design mockup: centred under the anchor, flips above it when
// there isn't room below (the instrument bar is docked at the bottom of
// the screen, so popovers usually open upward), clamped within the
// viewport horizontally, with a caret pointing back at the anchor.
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
    if (panelEl && !panelEl.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) close();
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  function position() {
    const ar = anchorEl.getBoundingClientRect();
    const midX = ar.left + ar.width / 2;
    const spaceBelow = window.innerHeight - ar.bottom;
    const above = spaceBelow < panelEl.offsetHeight + 20;
    panelEl.classList.toggle("above", above);
    panelEl.classList.toggle("below", !above);

    let left = midX - panelEl.offsetWidth / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - panelEl.offsetWidth - 10));
    panelEl.style.left = `${window.scrollX + left}px`;
    panelEl.style.top = `${window.scrollY + (above ? ar.top - panelEl.offsetHeight - 8 : ar.bottom + 8)}px`;
    panelEl.style.setProperty("--caret", `${midX - left}px`);
  }

  function open() {
    if (panelEl) { close(); return; }
    panelEl = document.createElement("div");
    panelEl.className = "value-panel glass";
    panelEl.style.position = "absolute";
    document.body.appendChild(panelEl);
    buildContent(panelEl, close);
    position();

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

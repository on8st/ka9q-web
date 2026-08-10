// VFO-style click-to-tune digits, per the design brief's "Tuning happens
// on the digits" behaviour: clicking the upper half of a digit raises it,
// the lower half lowers it, and the value carries into neighbouring
// digits the way a real VFO does. Carrying is just integer place-value
// arithmetic - re-deriving every digit from the new integer after each
// step means carries happen for free, no manual borrow/carry logic needed.
// DOM structure/styling matches the approved design mockup exactly
// (lead-zero dimming, dot separators, MHz suffix, hover half-highlight,
// wheel-to-step, double-click to type an exact value).

// 999,999,999 Hz (999.999999 MHz) comfortably covers HF through UHF on
// this station; a real 9-digit odometer display.
export const NUM_DIGITS = 9;
export const MAX_HZ = 10 ** NUM_DIGITS - 1;

export function digitsForFreq(hz, numDigits = NUM_DIGITS) {
  const clamped = Math.min(Math.max(0, Math.round(hz)), 10 ** numDigits - 1);
  return clamped.toString().padStart(numDigits, "0").slice(-numDigits).split("").map(Number);
}

/** digitIndexFromRight: 0 = ones (Hz), 1 = tens, ... direction: +1 or -1.
 * Returns the new frequency in Hz, clamped to [0, MAX_HZ]. */
export function stepFreqAtDigit(hz, digitIndexFromRight, direction) {
  const placeValue = 10 ** digitIndexFromRight;
  const stepped = Math.round(hz) + direction * placeValue;
  return Math.min(Math.max(0, stepped), MAX_HZ);
}

/**
 * Builds the digit row inside `container`. Calls onStep(newHz) whenever a
 * digit is stepped (click or wheel) or an exact value is typed (double-
 * click) - it does NOT update the display itself (the caller decides
 * whether/when to reflect a step immediately or wait for the server's own
 * tunedFreq echo, same "server state is authoritative" posture
 * ka9q-web.c itself takes - see PROTOCOL-TEXT.md). Call the returned
 * render(hz) to set what's shown.
 */
export function createDigitDisplay(container, onStep, numDigits = NUM_DIGITS) {
  container.classList.add("digits");
  let currentHz = 0;

  function renderDigits() {
    const s = digitsForFreq(currentHz, numDigits);
    let html = "";
    let lead = true;
    for (let i = 0; i < numDigits; i++) {
      if (i === 3 || i === 6) html += '<span class="sep">.</span>';
      if (s[i] !== 0) lead = false;
      const digitIndexFromRight = numDigits - 1 - i;
      html += `<span class="d${lead && i < 2 ? " lead" : ""}" data-idx="${digitIndexFromRight}">`
        + `<span class="ar u">▲</span><span class="num">${s[i]}</span><span class="ar d">▼</span></span>`;
    }
    container.innerHTML = html + '<span class="unit">MHz</span>';
  }

  function render(hz) {
    currentHz = hz;
    renderDigits();
  }
  render(0);

  container.addEventListener("mousemove", (e) => {
    const d = e.target.closest(".d");
    container.querySelectorAll(".d").forEach((x) => x.classList.remove("up", "dn"));
    if (!d) return;
    const r = d.getBoundingClientRect();
    d.classList.add(e.clientY - r.top < r.height / 2 ? "up" : "dn");
  });
  container.addEventListener("mouseleave", () => {
    container.querySelectorAll(".d").forEach((x) => x.classList.remove("up", "dn"));
  });
  container.addEventListener("click", (e) => {
    const d = e.target.closest(".d");
    if (!d) return;
    const r = d.getBoundingClientRect();
    const direction = e.clientY - r.top < r.height / 2 ? 1 : -1;
    onStep(stepFreqAtDigit(currentHz, Number(d.dataset.idx), direction));
  });
  container.addEventListener("wheel", (e) => {
    const d = e.target.closest(".d");
    if (!d) return;
    e.preventDefault();
    onStep(stepFreqAtDigit(currentHz, Number(d.dataset.idx), e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  container.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    const input = document.createElement("input");
    input.className = "freq-entry";
    input.value = (currentHz / 1000).toFixed(3);
    container.innerHTML = "";
    container.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      const v = parseFloat(input.value.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(v)) onStep(Math.round(v * 1000));
      else renderDigits();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") commit();
      if (ev.key === "Escape") renderDigits();
    });
  });

  return { render };
}

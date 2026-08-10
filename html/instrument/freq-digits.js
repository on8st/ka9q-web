// VFO-style click-to-tune digits, per the design brief's "Tuning happens
// on the digits" behaviour: clicking the upper half of a digit raises it,
// the lower half lowers it, and the value carries into neighbouring
// digits the way a real VFO does. Carrying is just integer place-value
// arithmetic - re-deriving every digit from the new integer after each
// step means carries happen for free, no manual borrow/carry logic needed.

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
 * Builds a row of clickable digit elements inside `container`. Calls
 * onStep(newHz) whenever a digit's upper/lower half is clicked - it does
 * NOT update the display itself (the caller decides whether/when to
 * reflect a step immediately or wait for the server's own tunedFreq echo,
 * same "server state is authoritative" posture ka9q-web.c itself takes -
 * see PROTOCOL-TEXT.md). Call the returned render(hz) to set what's shown.
 */
export function createDigitDisplay(container, onStep, numDigits = NUM_DIGITS) {
  container.innerHTML = "";
  container.classList.add("vfo-digits");
  const spans = [];
  let currentHz = 0;

  for (let i = 0; i < numDigits; i++) {
    const digitIndexFromRight = numDigits - 1 - i;
    if (digitIndexFromRight > 0 && digitIndexFromRight % 3 === 2 && i > 0) {
      const sep = document.createElement("span");
      sep.className = "vfo-sep";
      sep.textContent = " ";
      container.appendChild(sep);
    }
    const span = document.createElement("span");
    span.className = "vfo-digit";
    span.textContent = "0";
    span.title = "Click upper half to raise, lower half to lower this digit";
    span.addEventListener("click", (e) => {
      const rect = span.getBoundingClientRect();
      const direction = (e.clientY - rect.top) < rect.height / 2 ? 1 : -1;
      onStep(stepFreqAtDigit(currentHz, digitIndexFromRight, direction));
    });
    spans.push(span);
    container.appendChild(span);
  }

  function render(hz) {
    currentHz = hz;
    digitsForFreq(hz, numDigits).forEach((d, i) => { spans[i].textContent = String(d); });
  }

  return { render };
}

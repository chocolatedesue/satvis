// Where Cesium's credit line goes while the deck is up. The case is set here; the
// offsets are in main.css, which has to fight the inline `bottom` Cesium rewrites.

import { onUnmounted } from "vue";

const BODY_CLASS = "clock-deck";

type CreditPlace = "clear" | "beside" | "folded";

// Where the credit line fits left of the surface: its 206 px box plus 10 px of air,
// against a surface starting at `50% − 95`. Not measured at runtime — the line is a
// fifth of its width until the ion logo loads.
const CREDIT_BESIDE_MIN_PX = 624;

export function useClockDeckChrome() {
  let folded = false;

  const place = (): CreditPlace => {
    if (folded) {
      return "folded";
    }
    return window.innerWidth >= CREDIT_BESIDE_MIN_PX ? "beside" : "clear";
  };

  const apply = (): void => {
    document.body.dataset.clockDeck = place();
  };

  function attach(startFolded: boolean): void {
    folded = startFolded;
    document.body.classList.add(BODY_CLASS);
    apply();
    window.addEventListener("resize", apply);
  }

  function setFolded(value: boolean): void {
    folded = value;
    apply();
  }

  function detach(): void {
    window.removeEventListener("resize", apply);
    document.body.classList.remove(BODY_CLASS);
    delete document.body.dataset.clockDeck;
  }

  onUnmounted(detach);

  return { attach, setFolded };
}

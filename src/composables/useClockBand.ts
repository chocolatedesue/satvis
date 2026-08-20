// The band's two instruments as gestures: a ruler dragged past a fixed needle, and a
// ladder of speeds swiped under the same middle. One drag model for both.

import { computed, onUnmounted, ref, type Ref } from "vue";

import {
  arrowStep,
  CHIP_PX,
  clampMagnitude,
  decayVelocity,
  MAX_SCRUB_VELOCITY,
  MAX_SWIPE_VELOCITY,
  MIN_SWIPE_VELOCITY,
  MS_PER_PX,
  nearestRung,
  rulerTicks,
  LADDER,
} from "../modules/util/clockDeck";
import { DeviceDetect } from "../modules/util/DeviceDetect";
import type { ViewerClock } from "./useViewerClock";

/** Reduced motion still settles; it just arrives at once. */
const scrollBehavior = (): ScrollBehavior => (DeviceDetect.prefersReducedMotion() ? "auto" : "smooth");

/**
 * Move with the finger, coast on release, settle when the coast runs out.
 *
 * Works in the caller's units — sim ms for the ruler, scroll px for the ladder — so
 * velocities are those units per real ms. `advance` answers whether the move landed,
 * which is how the coast knows it has hit the end of the ladder.
 */
function useFlickDrag(options: {
  unitsPerPixel: number;
  maxVelocity: number;
  minVelocity: number;
  onStart?: () => void;
  advance: (delta: number) => boolean;
  onSettle: (moved: boolean) => void;
}) {
  let dragging = false;
  // A press that never moved is not a gesture: the ruler must not pin, and the ladder
  // must let the rung's own tap through.
  let moved = false;
  let lastX = 0;
  let lastAt = 0;
  let velocity = 0;
  let frame = 0;
  let coasting = false;

  function onDown(event: PointerEvent): void {
    cancelAnimationFrame(frame);
    coasting = false;
    dragging = true;
    moved = false;
    velocity = 0;
    lastX = event.clientX;
    lastAt = event.timeStamp;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    options.onStart?.();
  }

  function onMove(event: PointerEvent): void {
    if (!dragging) {
      return;
    }
    const dx = event.clientX - lastX;
    if (dx === 0) {
      return;
    }
    moved = true;
    // Floored at 1 ms, hence the clamp: two events in one millisecond would hand the
    // coast a speed that runs for days.
    const dt = Math.max(1, event.timeStamp - lastAt);
    lastX = event.clientX;
    lastAt = event.timeStamp;
    const delta = -dx * options.unitsPerPixel;
    velocity = clampMagnitude(delta / dt, options.maxVelocity);
    options.advance(delta);
  }

  function onUp(): void {
    if (!dragging) {
      return;
    }
    dragging = false;
    // Nothing to carry, and a coast would leave the settle waiting on a frame that
    // never comes in a hidden tab.
    if (!moved || DeviceDetect.prefersReducedMotion() || Math.abs(velocity) < options.minVelocity) {
      options.onSettle(moved);
      return;
    }
    coasting = true;
    glide(performance.now());
  }

  function glide(previous: number): void {
    frame = requestAnimationFrame((at) => {
      const dt = at - previous;
      const advanced = options.advance(velocity * dt);
      velocity = decayVelocity(velocity, dt);
      if (advanced && Math.abs(velocity) > options.minVelocity) {
        glide(at);
        return;
      }
      coasting = false;
      options.onSettle(true);
    });
  }

  const stop = (): void => cancelAnimationFrame(frame);

  return { onDown, onMove, onUp, stop, dragging: () => dragging, gliding: () => coasting, moved: () => moved };
}

export function useRuler(clock: ViewerClock, ruler: Ref<HTMLElement | undefined>) {
  const width = ref(360);
  const ticks = computed(() => rulerTicks(clock.now.value.getTime(), width.value));

  // Sim ms per real ms; the floor is a coast moving the clock by under a ms a frame.
  const drag = useFlickDrag({
    unitsPerPixel: MS_PER_PX,
    maxVelocity: MAX_SCRUB_VELOCITY,
    minVelocity: 1 / MS_PER_PX,
    onStart: () => clock.beginScrub(),
    advance: (delta) => {
      clock.scrubTo(new Date(clock.now.value.getTime() + delta));
      return true;
    },
    // `endScrub` writes the store, so a stray tap would pin the clock at a time it
    // never left.
    onSettle: (moved) => (moved ? clock.endScrub() : clock.cancelScrub()),
  });

  /** The only path without a pointer. */
  function onKey(event: KeyboardEvent): void {
    const direction = arrowStep(event.key);
    if (direction === 0) {
      return;
    }
    event.preventDefault();
    const step = (event.shiftKey ? 3_600_000 : 600_000) * direction;
    clock.beginScrub();
    clock.scrubTo(new Date(clock.now.value.getTime() + step));
    clock.endScrub();
  }

  const measure = (): void => {
    width.value = ruler.value?.clientWidth ?? width.value;
  };

  window.addEventListener("resize", measure);
  onUnmounted(() => {
    window.removeEventListener("resize", measure);
    drag.stop();
  });

  return { ticks, width, onDown: drag.onDown, onMove: drag.onMove, onUp: drag.onUp, onKey, measure };
}

/**
 * A scroll container the finger drags directly. Native `scroll-snap-type: x mandatory`
 * is nothing at all under a mouse, and it re-snaps every programmatic write, so the
 * ladder notches against the finger; `settle` rests it on a rung instead.
 */
export function useLadder(clock: ViewerClock, strip: Ref<HTMLElement | undefined>, chipPx: number = CHIP_PX) {
  // A programmatic scroll raises the same event a finger does.
  let settling = false;
  let settleTarget = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let rest: ReturnType<typeof setTimeout> | undefined;

  /** A backstop only: the window normally closes when the scroll arrives, because no flat number fits every distance. */
  const SETTLE_BACKSTOP_MS = 2000;
  /** How long a wheel has to stop before the ladder straightens itself. */
  const REST_MS = 120;

  function scrollToRung(at: number, behavior: ScrollBehavior): void {
    settling = true;
    settleTarget = at * chipPx;
    strip.value?.scrollTo({ left: settleTarget, behavior });
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settling = false;
    }, SETTLE_BACKSTOP_MS);
    clock.setRung(at);
  }

  const restingRung = (): number => nearestRung(strip.value?.scrollLeft ?? 0, chipPx);

  function onScroll(): void {
    if (!strip.value) {
      return;
    }
    if (settling) {
      if (Math.abs(strip.value.scrollLeft - settleTarget) < 1) {
        settling = false;
        clearTimeout(settleTimer);
      }
      return;
    }
    const value = LADDER[restingRung()]!;
    if (value !== clock.multiplier.value) {
      clock.setMultiplier(value);
    }
    // A wheel can leave it between rungs; a drag and a coast settle themselves.
    if (!drag.dragging() && !drag.gliding()) {
      clearTimeout(rest);
      rest = setTimeout(settle, REST_MS);
    }
  }

  // Scroll px per real ms. The element clamps `scrollLeft`, so an unchanged write is
  // how a coast learns it has hit an end.
  const drag = useFlickDrag({
    unitsPerPixel: 1,
    maxVelocity: MAX_SWIPE_VELOCITY,
    minVelocity: MIN_SWIPE_VELOCITY,
    onStart: () => {
      clearTimeout(settleTimer);
      clearTimeout(rest);
      // From here the scroll is a finger's, and each rung it passes sets the speed.
      settling = false;
    },
    advance: (delta) => {
      if (!strip.value) {
        return false;
      }
      const before = strip.value.scrollLeft;
      strip.value.scrollLeft += delta;
      return strip.value.scrollLeft !== before;
    },

    onSettle: (moved) => {
      if (moved) {
        settle();
      }
    },
  });

  /** Rest on a rung, never between two. */
  function settle(): void {
    const rung = restingRung();
    // Animating from a rung to itself is how this loops.
    if (strip.value && Math.abs(strip.value.scrollLeft - rung * chipPx) < 1) {
      return;
    }
    scrollToRung(rung, scrollBehavior());
  }

  /**
   * A rung's own tap. Ignored after a swipe: the pointer is captured by the rung it
   * went down on, so the browser fires a click there whatever the finger did next.
   */
  function pick(rung: number): void {
    if (drag.moved()) {
      return;
    }
    scrollToRung(rung, scrollBehavior());
  }

  /** Put the ladder on a rung. Animated where a tap would animate; instant when arriving on the rung already in force. */
  const showRung = (rung: number, { animate }: { animate: boolean }): void => scrollToRung(rung, animate ? scrollBehavior() : "auto");

  /** Arrow keys, a rung at a time. */
  function step(direction: number, from: number): number {
    const next = Math.min(LADDER.length - 1, Math.max(0, from + direction));
    if (next !== from) {
      scrollToRung(next, "auto");
    }
    return next;
  }

  onUnmounted(() => {
    clearTimeout(settleTimer);
    clearTimeout(rest);
    drag.stop();
  });

  return { onScroll, onDown: drag.onDown, onMove: drag.onMove, onUp: drag.onUp, pick, showRung, step };
}

// Walking the observer around while the sky view is up.
//
// Two things shape this module.
//
// The keys are read from `window`, not from the Cesium canvas the pointer
// gestures listen on: a canvas takes no keyboard focus, and giving it a tabindex
// so it could would put a focus ring on the globe and change what Tab does across
// the whole app. What listening globally costs is that a W typed into the
// satellite search would also walk — hence the editable-target check in `press`.
//
// And the two halves run at different rates: the view moves every frame, while
// `onMove` reports once the keys have been still for a moment. That callback is
// where the walk stops being a camera position and becomes the observer — which
// is a ground station move, with everything that costs. Why it is deferred rather
// than continuous is argued in docs/adr/0003-sky-view.md.

import { Math as CesiumMath } from "@cesium/engine";

import type { Aim, Observer } from "./skyGeometry";
import { offsetObserver } from "./skyGeometry";

/**
 * What each key does, keyed by `code` rather than by `key`, because WASD is a
 * shape on the keyboard rather than four letters: `code` names the physical key,
 * so the same block of four sits under the same fingers on azerty and qwertz.
 */
const MOVEMENT_KEYS: Record<string, { forward?: number; right?: number; up?: number }> = {
  KeyW: { forward: 1 },
  KeyS: { forward: -1 },
  KeyA: { right: -1 },
  KeyD: { right: 1 },
  KeyE: { up: 1 },
  KeyQ: { up: -1 },
};

/** How fast the observer walks, in metres per second. */
export const WALK_SPEED = 20;

/**
 * What holding shift is worth. A neighbourhood is a walk away at the base speed
 * and the next town is not; at eight times it is about a minute per kilometre,
 * which is the range the sky visibly changes over.
 */
export const SPRINT_FACTOR = 8;

/** A frame this long is a tab coming back, not a step. */
const MAX_STEP_MS = 100;

/**
 * How still the keys have to be before the walk becomes a ground station move.
 * Long enough to ride out the gap between two taps of a key, short enough that
 * letting go and looking at the url feels like the same act.
 */
export const SETTLE_MS = 350;

/**
 * The parts of a keyboard event this cares about.
 *
 * Structural, so a `KeyboardEvent` is one and a test needs no DOM to make one.
 * `target` is `unknown` on purpose: what it is asked is whether somebody is
 * typing, which is a duck-typed question about an element that may not exist.
 */
export interface KeyPress {
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target?: unknown;
}

/** What a walk needs of the sky view, and nothing else. */
export interface WalkableView {
  readonly settled: boolean;
  readonly observer: Observer | undefined;
  readonly aim: Readonly<Aim>;
  eyeHeight: number;
  moveObserver(observer: Observer): void;
  remeasureGround(): void;
}

export interface SkyMovementOptions {
  skyView: WalkableView;
  /** Where the observer came to rest, once the keys have been still. */
  onMove?: (observer: Observer) => void;
}

/** Whether a keystroke was aimed at somewhere text goes. */
function isTyping(target: unknown): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null | undefined;
  return element?.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(String(element?.tagName ?? ""));
}

/**
 * How far a set of held keys moves the observer, in metres east, north and up.
 *
 * Exported because it is the part worth testing on its own, and pure so that it
 * can be. Forward is the heading and nothing else — the pitch is deliberately
 * not in it: the sky view spends its time looking up, and moving along the view
 * axis would fly the observer into the sky rather than across the ground, which
 * is what the up and down keys are for.
 */
export function walkOffset(held: Iterable<string>, azimuth: number, seconds: number, sprint = false): { east: number; north: number; up: number } {
  let forward = 0;
  let right = 0;
  let up = 0;
  for (const code of held) {
    const axis = MOVEMENT_KEYS[code];
    forward += axis?.forward ?? 0;
    right += axis?.right ?? 0;
    up += axis?.up ?? 0;
  }

  const distance = WALK_SPEED * (sprint ? SPRINT_FACTOR : 1) * seconds;
  // Normalised, so that walking a diagonal is not a shortcut to going faster.
  // Only across the ground: climbing while walking is two movements, not one
  // gesture pointed between them.
  const diagonal = Math.hypot(forward, right);
  if (diagonal > 0) {
    forward /= diagonal;
    right /= diagonal;
  }

  const radians = CesiumMath.toRadians(azimuth);
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return {
    east: (forward * sin + right * cos) * distance,
    north: (forward * cos - right * sin) * distance,
    up: up * distance,
  };
}

export class SkyMovement {
  #options: SkyMovementOptions;

  /** Every movement key currently down, by `code`. */
  #held = new Set<string>();

  #sprint = false;

  #lastStep: number | undefined;

  /**
   * When a walk that has not been reported yet becomes reportable, or undefined
   * when there is no walk owing. Pushed forward on every frame a key is held, so
   * it only arrives once the keys have been still for the settle.
   */
  #settleAt: number | undefined;

  #listening = false;

  constructor(options: SkyMovementOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#listening) {
      return;
    }
    this.#listening = true;
    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    // A key held across an alt-tab never sends its keyup here, and the observer
    // would go on walking for as long as the window was away.
    window.addEventListener("blur", this.#onBlur);
  }

  stop(): void {
    if (!this.#listening) {
      return;
    }
    this.#listening = false;
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("blur", this.#onBlur);
    this.#release();
    // A walk that had not settled yet is dropped rather than reported. The view
    // is leaving, and moving a ground station on the way out would be seen by
    // the watcher that turns a station move into an `enter` — which, mid-exit,
    // turns the flight around and brings the sky view back.
    this.#settleAt = undefined;
    this.#lastStep = undefined;
  }

  /** Hold a key down. Public so the walk can be driven without a DOM. */
  press(event: KeyPress): void {
    this.#sprint = event.shiftKey;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // A modifier means a shortcut — the browser's or the platform's — and the
      // keyup for anything already down may well go to whatever it summons.
      this.#release();
      return;
    }
    if (!(event.code in MOVEMENT_KEYS) || isTyping(event.target)) {
      return;
    }
    this.#held.add(event.code);
  }

  /** Let a key up. Unconditional: a key that never comes back up walks forever. */
  release(event: KeyPress): void {
    this.#sprint = event.shiftKey;
    this.#held.delete(event.code);
  }

  /**
   * Advance the walk to `now`, and settle it once the keys have been still.
   *
   * Driven from the caller's own per-frame callback rather than from a listener
   * of its own, so there is one frame clock. Wall time rather than the viewer's:
   * a speed in metres per second means the user's seconds, whatever multiplier
   * the clock is running at.
   */
  step(now: number): void {
    const elapsed = this.#lastStep === undefined ? 0 : Math.min(now - this.#lastStep, MAX_STEP_MS);
    this.#lastStep = now;

    const { skyView } = this.#options;
    // Only once the camera has landed. During a flight the aim is the
    // destination rather than a heading, and so is the observer — walking then
    // would move where the view is going instead of where it is.
    if (!skyView.settled) {
      return;
    }

    if (this.#held.size > 0) {
      this.#walk(elapsed / 1000);
      this.#settleAt = now + SETTLE_MS;
      return;
    }
    if (this.#settleAt === undefined || now < this.#settleAt) {
      return;
    }
    this.#settleAt = undefined;

    // The height that carried the walk was measured on a throttle and up to a
    // step behind; ask for the one that is not. Not left to the ground station
    // move to provoke, either: a walk shorter than the store's coordinate
    // precision writes nothing, and would leave the last throttled answer
    // standing as if it were the final one.
    skyView.remeasureGround();
    const observer = skyView.observer;
    if (observer) {
      this.#options.onMove?.(observer);
    }
  }

  #walk(seconds: number): void {
    const { skyView } = this.#options;
    const observer = skyView.observer;
    if (!observer || seconds <= 0) {
      return;
    }
    const { east, north, up } = walkOffset(this.#held, skyView.aim.azimuth, seconds, this.#sprint);
    if (east !== 0 || north !== 0) {
      skyView.moveObserver(offsetObserver(observer, east, north));
    }
    if (up !== 0) {
      skyView.eyeHeight += up;
    }
  }

  /**
   * Let every key go. Deliberately leaves `#settleAt` where it is: dropping the
   * keys is how a walk ends, not how it is cancelled, and the deadline the last
   * moving frame set is exactly when that walk becomes reportable.
   */
  #release(): void {
    this.#held.clear();
    this.#sprint = false;
  }

  #onKeyDown = (event: KeyboardEvent): void => this.press(event);

  #onKeyUp = (event: KeyboardEvent): void => this.release(event);

  #onBlur = (): void => this.#release();
}

// Looking around the sky view, and identifying what the crosshair is on.
//
// Listeners go on the Cesium canvas rather than on a full-screen overlay. That
// is load-bearing: `#cesiumContainer` is a sibling *before* `#app`, and `#app`
// isolates its stacking context, so nothing rendered inside the app can be
// raised above Cesium's clock, timeline and credits — a full-screen surface
// would silently swallow their clicks and there would be no z-index that fixes
// it. Those widgets are siblings of the canvas, not children, so listening here
// leaves them alone by construction and the HUD can stay `pointer-events: none`
// throughout.

import { Cartesian2, type JulianDate, type Scene } from "@cesium/engine";

import type { SatelliteManager } from "./SatelliteManager";
import { nearestTarget, observerFrame, type SkyTarget, skyTargets } from "./SkyTargets";
import type { SkyView } from "./SkyView";

/** How far the crosshair reaches, in CSS pixels. */
export const CAPTURE_RADIUS = 60;

/**
 * A drag this small is a tap. Enough to absorb the hand tremor of a real tap on
 * a phone without swallowing a deliberate short flick.
 */
const TAP_SLOP = 8;

export interface SkyInteractionOptions {
  scene: Scene;
  skyView: SkyView;
  sats: SatelliteManager;
  /** Called whenever the locked target changes, including to nothing. */
  onLockChange?: (target: SkyTarget | undefined) => void;
  /** Called when a satellite is chosen, so the caller can open the info panel. */
  onSelect?: (target: SkyTarget) => void;
}

export class SkyInteraction {
  #options: SkyInteractionOptions;

  #canvas: HTMLCanvasElement | undefined;

  #removePreRender: (() => void) | undefined;

  #pointerId: number | undefined;

  #dragged = 0;

  #last = new Cartesian2();

  #targets: SkyTarget[] = [];

  #locked: SkyTarget | undefined;

  constructor(options: SkyInteractionOptions) {
    this.#options = options;
  }

  /** Everything currently in the observer's sky, refreshed each frame. */
  get targets(): readonly SkyTarget[] {
    return this.#targets;
  }

  get locked(): SkyTarget | undefined {
    return this.#locked;
  }

  start(): void {
    if (this.#canvas) {
      return;
    }
    const { scene } = this.#options;
    this.#canvas = scene.canvas;
    this.#canvas.addEventListener("pointerdown", this.#onPointerDown);
    this.#canvas.addEventListener("pointermove", this.#onPointerMove);
    this.#canvas.addEventListener("pointerup", this.#onPointerUp);
    this.#canvas.addEventListener("pointercancel", this.#onPointerUp);
    this.#removePreRender = scene.preRender.addEventListener((_scene: Scene, time: JulianDate) => this.#refresh(time));
  }

  stop(): void {
    if (!this.#canvas) {
      return;
    }
    this.#canvas.removeEventListener("pointerdown", this.#onPointerDown);
    this.#canvas.removeEventListener("pointermove", this.#onPointerMove);
    this.#canvas.removeEventListener("pointerup", this.#onPointerUp);
    this.#canvas.removeEventListener("pointercancel", this.#onPointerUp);
    this.#canvas = undefined;
    this.#removePreRender?.();
    this.#removePreRender = undefined;
    this.#pointerId = undefined;
    this.#targets = [];
    this.#setLocked(undefined);
  }

  /** Screen centre, where the crosshair is, in CSS pixels. */
  #center(): Cartesian2 {
    const { canvas } = this.#options.scene;
    return new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  }

  #refresh(time: JulianDate): void {
    const { scene, skyView, sats } = this.#options;
    if (!skyView.active) {
      return;
    }
    const frame = observerFrame(scene.camera.position);
    this.#targets = skyTargets(scene, frame, sats.activeSatellites, time);
    this.#setLocked(nearestTarget(this.#targets, this.#center(), CAPTURE_RADIUS));
  }

  #setLocked(target: SkyTarget | undefined): void {
    // Compare by satellite, not by target: the object is rebuilt every frame.
    if (this.#locked?.sat === target?.sat) {
      this.#locked = target;
      return;
    }
    this.#locked = target;
    this.#options.onLockChange?.(target);
  }

  #onPointerDown = (event: PointerEvent): void => {
    if (this.#pointerId !== undefined) {
      return;
    }
    this.#pointerId = event.pointerId;
    this.#dragged = 0;
    this.#last = new Cartesian2(event.clientX, event.clientY);
    this.#canvas?.setPointerCapture(event.pointerId);
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) {
      return;
    }
    const dx = event.clientX - this.#last.x;
    const dy = event.clientY - this.#last.y;
    this.#last = new Cartesian2(event.clientX, event.clientY);
    this.#dragged += Math.abs(dx) + Math.abs(dy);

    // Degrees per pixel straight off the vertical field of view, so dragging
    // moves the sky by the amount that lies under the cursor at any zoom.
    const { skyView, scene } = this.#options;
    const height = scene.canvas.clientHeight || 1;
    const perPixel = skyView.fovy / height;
    const { azimuth, elevation } = skyView.aim;
    skyView.look({
      azimuth: azimuth - dx * perPixel,
      // Clamped rather than wrapped: passing the zenith would need the azimuth
      // to flip and the roll to follow it, and a clamp is what a mouse expects.
      elevation: Math.min(90, Math.max(-90, elevation + dy * perPixel)),
    });
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId) {
      return;
    }
    this.#pointerId = undefined;
    this.#canvas?.releasePointerCapture?.(event.pointerId);
    if (this.#dragged > TAP_SLOP) {
      return;
    }
    // A tap selects whatever the crosshair is on — not what is under the finger.
    // The crosshair is the instrument; the tap is only the trigger.
    if (this.#locked) {
      this.#options.onSelect?.(this.#locked);
    }
  };
}

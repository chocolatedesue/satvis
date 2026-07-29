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

import { aimFromDeviceOrientation, CompassCalibration, hasHeadingSource } from "./DeviceAim";
import type { SatelliteManager } from "./SatelliteManager";
import { nearestTarget, type SkyTarget, skyTargets } from "./SkyTargets";
import type { SkyView } from "./SkyView";

// iOS gates the sensor behind a call made from a user gesture, and only over
// https. Typed here because it is not in lib.dom.
interface DeviceOrientationPermission {
  requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
}

/** Safari's compass reading, absent everywhere else. */
interface CompassEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

/**
 * What came of handing the aim to the device.
 *
 * More than a boolean because the reasons need different words in front of the
 * user: a laptop has no sensor to grant, a phone whose permission was declined
 * can be asked again, and a device that reports orientation without a magnetometer
 * can aim relatively but has no idea where north is. The last one is refused
 * rather than accepted — see docs/adr/0004-compass-aiming.md.
 */
export type CompassOutcome =
  /** Aiming, and north is known. */
  | "aiming"
  /** Aiming, but north waits on the phone being held flat once. */
  | "aiming-uncalibrated"
  | "unsupported"
  | "denied"
  /** The event exists and was granted, but never fired. Desktop browsers do this. */
  | "silent"
  /** Orientation works, but nothing on this device can say where north is. */
  | "no-heading";

/** How far the crosshair reaches, in CSS pixels. */
export const CAPTURE_RADIUS = 60;

/**
 * A drag this small is a tap. Enough to absorb the hand tremor of a real tap on
 * a phone without swallowing a deliberate short flick.
 */
const TAP_SLOP = 8;

/**
 * Zoom per unit of wheel delta, applied multiplicatively so that equal gestures
 * feel like equal zoom rather than equal degrees.
 */
const WHEEL_ZOOM_RATE = 0.0015;

/** Wheel deltas arrive in lines or pages on some browsers; normalise to pixels. */
const WHEEL_DELTA_SCALE: Record<number, number> = { 1: 16, 2: 100 };

/** How long to wait for the orientation sensor to say something before giving up. */
const SENSOR_PROBE_MS = 1200;

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

  /** Every pointer currently down, so a second one can become a pinch. */
  #pointers = new Map<number, Cartesian2>();

  /**
   * Latched at the start of a pinch. The field of view is computed from these
   * rather than from the previous move, because accumulating per-move ratios
   * drifts over a long gesture.
   */
  #pinch: { startDistance: number; startFovy: number } | undefined;

  #targets: SkyTarget[] = [];

  #locked: SkyTarget | undefined;

  readonly compass = new CompassCalibration();

  #orientationActive = false;

  #sawOrientation = false;

  #sawHeadingSource = false;

  constructor(options: SkyInteractionOptions) {
    this.#options = options;
  }

  /** Whether the aim is following the device rather than the pointer. */
  get orientationActive(): boolean {
    return this.#orientationActive;
  }

  /**
   * Hand the aim over to the device's own orientation.
   *
   * Must be called from a user gesture: iOS gates the sensor behind a
   * permission prompt that only a gesture may raise, and only in a secure
   * context. Anything other than an "aiming" outcome leaves dragging in place.
   *
   * Both event names are subscribed. `deviceorientationabsolute` is Chrome's
   * earth-referenced variant and the only source of north on Android;
   * `deviceorientation` carries `webkitCompassHeading` on iOS and nothing useful
   * for north elsewhere. Whichever fires, the samples are the same shape.
   */
  async enableDeviceOrientation(): Promise<CompassOutcome> {
    if (this.#orientationActive) {
      return this.compass.calibrated ? "aiming" : "aiming-uncalibrated";
    }
    if (typeof DeviceOrientationEvent === "undefined") {
      return "unsupported";
    }
    const gate = DeviceOrientationEvent as unknown as DeviceOrientationPermission;
    if (typeof gate.requestPermission === "function") {
      try {
        if ((await gate.requestPermission()) !== "granted") {
          return "denied";
        }
      } catch {
        // Thrown when called outside a gesture, which is a refusal too.
        return "denied";
      }
    }
    window.addEventListener("deviceorientationabsolute", this.#onDeviceOrientation);
    window.addEventListener("deviceorientation", this.#onDeviceOrientation);
    this.#orientationActive = true;

    // Desktop browsers define the event and grant it happily, then never fire
    // it. Taking that as success would hand the aim to a sensor that does not
    // exist and silently freeze the view, so the sensor has to prove itself.
    this.#sawOrientation = false;
    this.#sawHeadingSource = false;
    await new Promise((resolve) => setTimeout(resolve, SENSOR_PROBE_MS));
    if (!this.#sawOrientation) {
      this.disableDeviceOrientation();
      return "silent";
    }
    // Orientation without any way to find north would aim at an azimuth measured
    // from wherever the device happened to be, which looks like a working sky and
    // is not one.
    if (!this.#sawHeadingSource) {
      this.disableDeviceOrientation();
      return "no-heading";
    }
    return this.compass.calibrated ? "aiming" : "aiming-uncalibrated";
  }

  disableDeviceOrientation(): void {
    if (!this.#orientationActive) {
      return;
    }
    window.removeEventListener("deviceorientationabsolute", this.#onDeviceOrientation);
    window.removeEventListener("deviceorientation", this.#onDeviceOrientation);
    this.#orientationActive = false;
  }

  #onDeviceOrientation = (event: DeviceOrientationEvent): void => {
    const { alpha, beta, gamma } = event;
    if (alpha === null || beta === null || gamma === null) {
      return;
    }
    this.#sawOrientation = true;
    const sample = { alpha, beta, gamma, screenAngle: screen.orientation?.angle ?? 0 };
    // `absolute` is only trusted from the absolute event: `deviceorientation` sets
    // it too, and sets it false, which would otherwise be read as a statement
    // about iOS's heading rather than about this event's own alpha.
    const reading = {
      compassHeading: (event as CompassEvent).webkitCompassHeading,
      absolute: event.type === "deviceorientationabsolute" && event.absolute,
    };
    this.#sawHeadingSource ||= hasHeadingSource(reading);
    // The compass is a yaw offset about world up, refreshed only from readings
    // that justify it, never folded into alpha — see DeviceAim.
    this.compass.update(sample, reading);
    this.#options.skyView.look(this.compass.correct(aimFromDeviceOrientation(sample)));
  };

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
    // Not passive: the wheel is the zoom, so the page must not also scroll.
    this.#canvas.addEventListener("wheel", this.#onWheel, { passive: false });
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
    this.#canvas.removeEventListener("wheel", this.#onWheel);
    this.#canvas = undefined;
    this.disableDeviceOrientation();
    this.#removePreRender?.();
    this.#removePreRender = undefined;
    this.#pointerId = undefined;
    this.#pointers.clear();
    this.#pinch = undefined;
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
    const frame = skyView.frame;
    if (!skyView.active || !frame) {
      return;
    }
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

  /** Zoom, about the crosshair. The aim is never touched: see the wheel handler. */
  #zoomBy(factor: number): void {
    const { skyView } = this.#options;
    if (!skyView.active) {
      return;
    }
    skyView.fovy *= factor;
  }

  /**
   * Zoom on the wheel, centred on the crosshair rather than the cursor.
   *
   * Zoom-to-cursor works by changing where the camera looks, and under device
   * orientation the sensor overwrites the aim on the next reading, so the
   * recentring would visibly snap back. Screen-centre is the only rule that
   * behaves the same under a drag and under the sensor.
   */
  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const pixels = event.deltaY * (WHEEL_DELTA_SCALE[event.deltaMode] ?? 1);
    // Scrolling down widens the field of view, which is zooming out.
    this.#zoomBy(Math.exp(pixels * WHEEL_ZOOM_RATE));
  };

  #pinchDistance(): number | undefined {
    const [first, second] = [...this.#pointers.values()];
    return first && second ? Cartesian2.distance(first, second) : undefined;
  }

  #onPointerDown = (event: PointerEvent): void => {
    this.#pointers.set(event.pointerId, new Cartesian2(event.clientX, event.clientY));
    this.#canvas?.setPointerCapture(event.pointerId);

    if (this.#pointers.size === 2) {
      // A second finger ends the drag and begins a pinch. A gesture is one or the
      // other: letting the pair drag as well would pan the sky while zooming it,
      // and zoom is meant to change the field of view and nothing else.
      this.#pointerId = undefined;
      this.#pinch = { startDistance: this.#pinchDistance() ?? 1, startFovy: this.#options.skyView.fovy };
      return;
    }
    if (this.#pointers.size === 1) {
      this.#pointerId = event.pointerId;
      this.#dragged = 0;
      this.#last = new Cartesian2(event.clientX, event.clientY);
    }
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (!this.#pointers.has(event.pointerId)) {
      return;
    }
    this.#pointers.set(event.pointerId, new Cartesian2(event.clientX, event.clientY));

    if (this.#pinch) {
      const distance = this.#pinchDistance();
      if (distance !== undefined && distance > 0) {
        // Fingers apart is zoom in, which is a narrower field of view. Twist is
        // ignored: roll is only ever driven by the device sensor.
        this.#options.skyView.fovy = (this.#pinch.startFovy * this.#pinch.startDistance) / distance;
      }
      return;
    }

    if (event.pointerId !== this.#pointerId) {
      return;
    }
    const dx = event.clientX - this.#last.x;
    const dy = event.clientY - this.#last.y;
    this.#last = new Cartesian2(event.clientX, event.clientY);
    this.#dragged += Math.abs(dx) + Math.abs(dy);

    // The device is aiming; a drag would be overwritten by the next sensor
    // reading anyway. Still counted above, so it stays a drag rather than a tap.
    if (this.#orientationActive) {
      return;
    }

    // Degrees per pixel straight off the vertical field of view, so dragging
    // moves the sky by the amount that lies under the cursor at any zoom.
    const { skyView, scene } = this.#options;
    const height = scene.canvas.clientHeight || 1;
    const perPixel = skyView.fovy / height;
    const { azimuth, pitch } = skyView.aim;
    skyView.look({
      azimuth: azimuth - dx * perPixel,
      // Clamped rather than wrapped: passing the zenith would need the azimuth
      // to flip and the roll to follow it, and a clamp is what a mouse expects.
      pitch: Math.min(90, Math.max(-90, pitch + dy * perPixel)),
    });
  };

  #onPointerUp = (event: PointerEvent): void => {
    const tracked = this.#pointers.delete(event.pointerId);
    this.#canvas?.releasePointerCapture?.(event.pointerId);
    if (!tracked) {
      return;
    }

    if (this.#pinch) {
      if (this.#pointers.size >= 2) {
        return;
      }
      this.#pinch = undefined;
      const [remaining] = [...this.#pointers.entries()];
      if (remaining) {
        // Re-seeded, not resumed: the surviving finger moved while it was pinching,
        // and taking that as drag would swing the sky by however far it travelled.
        // Past the tap slop on purpose — a gesture that pinched is not a tap.
        this.#pointerId = remaining[0];
        this.#last = remaining[1];
        this.#dragged = TAP_SLOP + 1;
      }
      return;
    }

    if (event.pointerId !== this.#pointerId) {
      return;
    }
    this.#pointerId = undefined;
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

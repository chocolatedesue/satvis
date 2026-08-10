// Looking around the sky view, and identifying what the crosshair is on.
//
// Pointer listeners go on the Cesium canvas rather than on a full-screen overlay. That
// is load-bearing: `#cesiumContainer` is a sibling *before* `#app`, and `#app`
// isolates its stacking context, so nothing rendered inside the app can be
// raised above Cesium's clock, timeline and credits — a full-screen surface
// would silently swallow their clicks and there would be no z-index that fixes
// it. Those widgets are siblings of the canvas, not children, so listening here
// leaves them alone by construction and the HUD can stay `pointer-events: none`
// throughout.
//
// Walking the observer is the exception, and lives in ./SkyMovement: a keyboard
// has nothing to do with the canvas, and where its keys are read from — and what
// a walk costs when it ends — is a whole argument of its own.

import { Cartesian2, type JulianDate, type Scene } from "@cesium/engine";

import { aimFromDeviceOrientation, CompassCalibration, hasHeadingSource } from "./DeviceAim";
import type { SatelliteManager } from "./SatelliteManager";
import { SkyMovement } from "./SkyMovement";
import { groundHides, nearestTarget, type SkyTarget, skyTargets } from "./SkyTargets";
import type { Observer, SkyView } from "./SkyView";

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
  | "no-heading"
  /**
   * The aim was taken back by hand while the sensor was still proving itself.
   * Nothing failed and there is nothing to say about it — the user did it — but
   * the control still has to hear that it is not aiming.
   */
  | "taken-back";

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

  /** How far this gesture has actually moved the pointer, in CSS pixels. */
  #dragged = 0;

  /**
   * Whether this gesture has been a pinch at any point. Kept apart from
   * `#dragged` because the two answer different questions of the same gesture —
   * "was that a tap" and "did the user take hold of the view" — and a pinch is
   * not a tap while its fingers may not have dragged at all.
   */
  #pinched = false;

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

  readonly movement: SkyMovement;

  #observerMoved: ((observer: Observer) => void) | undefined;

  #orientationStopped: (() => void) | undefined;

  #orientationActive = false;

  #sawOrientation = false;

  #sawHeadingSource = false;

  constructor(options: SkyInteractionOptions) {
    this.#options = options;
    this.movement = new SkyMovement({
      skyView: options.skyView,
      onMove: (observer) => this.#observerMoved?.(observer),
    });
  }

  /**
   * Called when a walk has come to rest somewhere new.
   *
   * A registration rather than a constructor option, unlike the callbacks above:
   * the observer is the first ground station, so what has to hear this is the
   * store — and the store is sceneSync's to write, while the interaction is the
   * controller's to construct. Same shape, and for the same reason, as
   * `sats.onTrackedChange`.
   */
  onObserverMove(callback: (observer: Observer) => void): void {
    this.#observerMoved = callback;
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
    // The aim can be taken back while the probe runs — a drag does exactly that,
    // and readings are already steering the view by then — so what is reported
    // has to be what is actually in force rather than what was asked for.
    if (!this.#orientationActive) {
      return "taken-back";
    }
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

  /**
   * Take the aim back from the device, whoever asked — the control, a drag, or
   * the view closing.
   *
   * The view is levelled on the way out. Nothing but the sensor ever rolls it,
   * so a roll left behind is one the pointer cannot straighten, and a horizon
   * stuck at the angle a phone happened to be held at does not read as a held
   * angle. It reads as a broken view.
   */
  disableDeviceOrientation(): void {
    if (!this.#orientationActive) {
      return;
    }
    window.removeEventListener("deviceorientationabsolute", this.#onDeviceOrientation);
    window.removeEventListener("deviceorientation", this.#onDeviceOrientation);
    this.#orientationActive = false;
    this.#options.skyView.look({ roll: 0 });
    this.#orientationStopped?.();
  }

  /**
   * Called whenever the aim stops following the device, including when nobody
   * asked for it — a drag takes the aim back, and the control that says the
   * compass is on has no other way to find out.
   */
  onOrientationStop(callback: () => void): void {
    this.#orientationStopped = callback;
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
    this.movement.start();
    this.#removePreRender = scene.preRender.addEventListener((_scene: Scene, time: JulianDate) => {
      this.movement.step(performance.now());
      this.#refresh(time);
    });
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
    this.movement.stop();
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
    // A crosshair points at what you can see, and the picture already hides what
    // the ground hides.
    this.#setLocked(nearestTarget(this.#targets, this.#center(), CAPTURE_RADIUS, (target) => groundHides(scene, frame, target.position)));
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
      this.#pinched = true;
      this.#pinch = { startDistance: this.#pinchDistance() ?? 1, startFovy: this.#options.skyView.fovy };
      return;
    }
    if (this.#pointers.size === 1) {
      this.#pointerId = event.pointerId;
      this.#dragged = 0;
      this.#pinched = false;
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

    // Taking hold of the view takes the aim back from the device. A drag under
    // sensor aiming is overwritten by the next reading, so the alternative is a
    // gesture that visibly does nothing — and there is no reading of "I dragged
    // and the sky sprang back" that is not "the compass is broken". Turning the
    // compass off is also the only handover that survives: the sensor writes the
    // aim every reading, so nothing short of unsubscribing can share it.
    //
    // Past the tap slop rather than on the first pixel, because a tap is how a
    // satellite is selected and the hand tremor inside one must not cost the
    // compass. Pixels this gesture actually travelled, which is why `#dragged` may
    // not stand in for "not a tap": a pinch is not a tap either, and one that ends
    // with a finger still down would otherwise hand the aim over on its first
    // pixel — zoom is meant to change the field of view and nothing else. The keys
    // are the same trade from the other side: walking never touches the aim, so it
    // leaves the compass alone.
    if (this.#orientationActive) {
      if (this.#dragged <= TAP_SLOP) {
        return;
      }
      this.disableDeviceOrientation();
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
        // `#dragged` restarts from where the finger is now — `#pinched` is what
        // remembers this was no tap, so the counter can stay honest about pixels.
        this.#pointerId = remaining[0];
        this.#last = remaining[1];
        this.#dragged = 0;
      }
      return;
    }

    if (event.pointerId !== this.#pointerId) {
      return;
    }
    this.#pointerId = undefined;
    if (this.#dragged > TAP_SLOP || this.#pinched) {
      return;
    }
    // A tap selects whatever the crosshair is on — not what is under the finger.
    // The crosshair is the instrument; the tap is only the trigger.
    if (this.#locked) {
      this.#options.onSelect?.(this.#locked);
    }
  };
}

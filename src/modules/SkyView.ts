// The sky view: the app's own camera, parked on the ground at the observer and
// aimed upward, so the satellites the globe already draws are seen from below.
//
// This module owns the camera and nothing else. It takes an observer and an aim
// and produces a camera basis; resolving who the observer is, and stopping the
// other things that want to drive the camera, belong to the caller
// (src/modules/sceneSync.ts). Rationale: docs/adr/0003-sky-view.md.
//
// Entering and leaving are flights rather than cuts, which is why the pose the
// camera is given each frame is not always the pose the aim asks for — see
// `#apply`, and src/modules/skyFlight.ts for the interpolation itself.
//
// Two Cesium behaviours shape the implementation:
//
//   - `camera.setView` cannot express this. It converts direction/up back into
//     heading/pitch/roll, and `getHeading` switches formula within EPSILON3 of
//     straight up — above about 87.4° of elevation the roll comes back wrong by
//     up to 180°, which mirrors the whole sky. So the basis is assigned
//     directly and Cesium is kept out of Euler angles entirely. The same
//     applies to `camera.flyTo`, which is why the flight is ours.
//   - `ScreenSpaceCameraController` runs its collision detection *outside* the
//     `enableInputs` check, so clearing that flag alone still leaves
//     `adjustHeightForTerrain` free to lift the camera off the observer on any
//     frame it thinks it moved. Both flags come off.

import { Cartesian3, Cartographic, Math as CesiumMath, Matrix3, Matrix4, PerspectiveFrustum, type Scene, SceneMode, Transforms } from "@cesium/engine";

import { flightDuration, type FlightPath, flightPose, newPose, type Pose } from "./skyFlight";
import { type Aim, enuDirection, type Observer, type ObserverFrame, observerFrame, rollBasis } from "./skyGeometry";

export type { Aim, Observer } from "./skyGeometry";

/** An orthonormal camera basis in east-north-up components. */
export interface Basis {
  direction: Cartesian3;
  up: Cartesian3;
  right: Cartesian3;
}

/** Eye height above the ground under the observer. */
const EYE_HEIGHT = 2;

/**
 * The range a ground elevation can credibly fall in — roughly the Dead Sea shore
 * to rather above Everest, with room to spare at both ends.
 */
const MIN_GROUND_HEIGHT = -500;
const MAX_GROUND_HEIGHT = 9000;

/**
 * Whether a surface height from `globe.getHeight` can be believed.
 *
 * It has to be asked, because the honest answer for "no tile loaded here" is not
 * `undefined`: with the default `EllipsoidTerrainProvider`, where the surface is
 * the ellipsoid and the answer is exactly 0, it has been observed returning
 * -36990. Taking that at face value puts the camera 37 km underground, which
 * stops the tiles under the observer from rendering at all, which keeps the
 * answer garbage — the view never recovers on its own.
 */
export const isPlausibleGroundHeight = (height: number | undefined): height is number =>
  height !== undefined && Number.isFinite(height) && height >= MIN_GROUND_HEIGHT && height <= MAX_GROUND_HEIGHT;

/**
 * Defaults chosen so the first frame is legible rather than empty sky. The
 * horizon is on screen because `pitch < fovy / 2`; that invariant is the whole
 * guarantee, which is why there is no per-orientation arithmetic here.
 */
export const DEFAULT_FOVY = 75;
export const DEFAULT_PITCH = 30;

/**
 * How far the view may zoom, stated as vertical field of view.
 *
 * 10° at the narrow end is roughly 7.5x magnification, which is what it takes to
 * separate two satellites sharing the reticle at the default zoom; below about 5°
 * hand tremor under device aiming dominates and it stops being precision. 100° at
 * the wide end is as much sky as the perspective will take — on a 21:9 window it
 * derives a horizontal `fov` of 141°, and the stretching at the edges is already
 * severe there.
 *
 * Note this deliberately lets the user break `pitch < fovy/2`, which is a
 * statement about the defaults on entry and not a standing invariant — zooming in
 * on something high up is *supposed* to take the horizon off screen.
 */
export const MIN_FOVY = 10;
export const MAX_FOVY = 100;

/** North is the emptiest direction to open on: passes culminate toward the equator. */
export const defaultAzimuth = (observer: Observer): number => (observer.lat >= 0 ? 180 : 0);

/**
 * The camera basis for an aim, in east-north-up components.
 *
 * Exported because this is the part worth testing: `up` and `right` are derived
 * from the aim angles rather than from a cross product against world up, so
 * there is no singularity at the zenith and no discontinuity crossing it.
 */
export function skyBasis(aim: Aim): Basis {
  return { direction: enuDirection(aim.azimuth, aim.pitch), ...rollBasis(aim.azimuth, aim.pitch, aim.roll) };
}

/**
 * The horizontal angle the view actually spans, at any aspect ratio.
 *
 * Distinct from `fovFromFovy` below, which answers the narrower question of what
 * to hand Cesium: on a portrait viewport Cesium's `fov` *is* the vertical angle,
 * so it is not the horizontal span and cannot be used as one.
 */
export function fovxFromFovy(fovyRadians: number, aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return fovyRadians;
  }
  return 2 * Math.atan(Math.tan(fovyRadians * 0.5) * aspectRatio);
}

/**
 * Cesium's `fov` is the horizontal angle on a landscape viewport and the
 * vertical one otherwise, so it means different things on a phone held two
 * ways. Everything here is specified vertically; this converts.
 */
export function fovFromFovy(fovyRadians: number, aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 1) {
    return fovyRadians;
  }
  return fovxFromFovy(fovyRadians, aspectRatio);
}

/**
 * The vertical angle behind a Cesium `fov`, and the exact inverse of
 * `fovFromFovy`. Needed on the way in: a flight starts at whatever the globe
 * camera's frustum was set to, and the flight interpolates vertical angles.
 */
export function fovyFromFov(fovRadians: number, aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 1) {
    return fovRadians;
  }
  return 2 * Math.atan(Math.tan(fovRadians * 0.5) / aspectRatio);
}

interface SavedState {
  pose: Pose;
  /** Cesium's own `fov`, put back verbatim; NaN when the frustum had none. */
  fov: number;
  requestRenderMode: boolean;
  enableInputs: boolean;
  enableCollisionDetection: boolean;
}

/**
 * Where the view is between the globe and the ground.
 *
 * `active` covers all three of the non-off states, because the sky view owns the
 * camera for the whole of them. `settled` is the narrower question the HUD and
 * the crosshair have to ask instead: is the camera where the aim says it is, or
 * is it still on its way there?
 */
type Phase = "off" | "entering" | "live" | "leaving";

interface Flight {
  /**
   * The globe end, the sky end and the straight-down attitude between them. The
   * same three objects for as long as the view is up: the sky end and the
   * attitude are rewritten under the flight each frame, because the ground under
   * the observer is only known once its tiles are in and the aim can still move
   * while the camera is on its way.
   */
  path: FlightPath;
  /** Leaving is the flight in played backwards, so it is one path and a sign. */
  reverse: boolean;
  startedAt: number;
  durationMs: number;
  finished: Promise<void>;
  /** Resolves `finished`, on landing or on another flight taking over. */
  finish: () => void;
}

function beginFlight(path: FlightPath, reverse: boolean, durationMs: number, elapsedMs: number): Flight {
  let finish = (): void => {};
  const finished = new Promise<void>((resolve) => {
    finish = () => resolve();
  });
  return { path, reverse, startedAt: performance.now() - elapsedMs, durationMs, finished, finish };
}

export class SkyView {
  #scene: Scene;

  #phase: Phase = "off";

  #flight: Flight | undefined;

  // Present exactly while the view is active, and the record of what has to be
  // put back. Restoring only what was actually changed is what lets the sky
  // view coexist with `?bg=false`, which has already destroyed the sky objects
  // a blanket restore would try to bring back.
  #saved: SavedState | undefined;

  // The pose the aim asks for, the same pose tipped all the way down, and the
  // pose actually given to the camera. Separate objects because during a flight
  // all three differ; the first two are the flight's destination and the
  // attitude it aims with, rewritten in place each frame so the descent keeps
  // re-aiming at ground that only shows up as tiles load.
  #sky: Pose = newPose();

  #over: Pose = newPose();

  #blended: Pose = newPose();

  #observer: Observer | undefined;

  // The observer's coordinates, kept in the form `globe.getHeight` wants so the
  // per-frame ground lookup allocates nothing.
  #observerCartographic = new Cartographic();

  // Sea level until a tile says otherwise, which is the exact answer for the
  // default terrain provider and a safe one for every other.
  #groundHeight = 0;

  #aim: Aim = { azimuth: 0, pitch: DEFAULT_PITCH, roll: 0 };

  #fovy: number = DEFAULT_FOVY;

  // Rebuilt only when the observer or the ground under it moves, which is rare;
  // everything that reads it wants it every frame.
  #frame: ObserverFrame | undefined;

  #removePreRender: (() => void) | undefined;

  constructor(scene: Scene) {
    this.#scene = scene;
  }

  /** Whether the sky view owns the camera — true throughout both flights. */
  get active(): boolean {
    return this.#phase !== "off";
  }

  /**
   * Whether the camera has arrived. Anything that reads the aim to say something
   * about the picture — the HUD's tapes, the crosshair — has to wait for this:
   * during a flight the aim is the destination, not where the camera is looking.
   */
  get settled(): boolean {
    return this.#phase === "live";
  }

  get observer(): Observer | undefined {
    return this.#observer;
  }

  get aim(): Readonly<Aim> {
    return this.#aim;
  }

  /** The observer's local frame, for anything measuring angles against it. */
  get frame(): ObserverFrame | undefined {
    return this.#frame;
  }

  get fovy(): number {
    return this.#fovy;
  }

  /** Clamped here rather than at each caller: it is a property of the view. */
  set fovy(degrees: number) {
    this.#fovy = CesiumMath.clamp(degrees, MIN_FOVY, MAX_FOVY);
    this.#apply();
  }

  /** Point somewhere else. Omitted angles keep their current value. */
  look(aim: Partial<Aim>): void {
    this.#aim = { ...this.#aim, ...aim };
    this.#apply();
  }

  /**
   * Stand at the observer and look up, arriving by flight rather than by cut.
   *
   * The promise resolves when the camera has landed, or when another flight
   * takes over from this one. That is what lets the caller hold the interaction
   * back until the aim and the picture agree — see src/modules/sceneSync.ts.
   */
  enter(observer: Observer): Promise<void> {
    if (this.#phase === "entering" || this.#phase === "live") {
      // Re-entering with a different observer is a move, not a second entry: the
      // saved globe state is the one from the original entry, and a move that
      // flew would turn dragging a ground station marker into a slideshow.
      this.#setObserver(observer);
      this.#apply();
      return this.#flight?.finished ?? Promise.resolve();
    }

    if (this.#phase === "leaving") {
      // Turned around rather than started afresh: the camera is mid-air, and
      // `#saved` is still the globe this flight was on its way back to.
      this.#reset(observer);
      const arrival = this.#fly("entering");
      this.#apply();
      return arrival;
    }

    // The sky view is 3D, so entering from 2D or Columbus has to morph first —
    // instantly, because the camera is about to be assigned outright and an
    // animated morph would spend two seconds fighting it. Without this the basis
    // lands in an orthographic projection where it means nothing, and the frustum
    // is not a PerspectiveFrustum so there is no `fov` to save or to put back.
    if (this.#scene.mode !== SceneMode.SCENE3D) {
      this.#scene.morphTo3D(0);
    }

    const { camera, screenSpaceCameraController: controller } = this.#scene;
    this.#saved = {
      pose: this.#cameraPose(),
      fov: (camera.frustum instanceof PerspectiveFrustum ? camera.frustum.fov : undefined) ?? Number.NaN,
      requestRenderMode: this.#scene.requestRenderMode,
      enableInputs: controller.enableInputs,
      enableCollisionDetection: controller.enableCollisionDetection,
    };

    this.#reset(observer);

    // A leftover reference frame — from `jumpTo`, or from tracking — would
    // reinterpret every vector assigned below.
    camera.lookAtTransform(Matrix4.IDENTITY);
    // Off for the flight as well as for the view: the descent is not something
    // to wrestle with, and collision detection would fight it all the way down.
    controller.enableInputs = false;
    controller.enableCollisionDetection = false;
    // The camera is driven from outside Cesium's own input handling, so there
    // is nothing for request-render mode to notice.
    this.#scene.requestRenderMode = false;

    const arrival = this.#fly("entering");
    // Re-asserted every frame rather than set once: the ground height under the
    // observer is only known after a render, the viewport aspect can change at
    // any time, and anything else that grabs the camera loses on the next frame.
    this.#removePreRender = this.#scene.preRender.addEventListener(() => this.#apply());
    this.#apply();
    return arrival;
  }

  /**
   * Fly back to the globe the camera was taken from, and hand it back.
   *
   * The promise resolves once the globe state is restored — the caller must wait
   * for it before morphing the projection or releasing the camera mode, because
   * until then this view is still flying the camera.
   */
  exit(): Promise<void> {
    if (this.#phase === "off") {
      return Promise.resolve();
    }
    if (this.#phase === "leaving") {
      return this.#flight?.finished ?? Promise.resolve();
    }
    if (!this.#saved) {
      // Unreachable: every non-off phase has a saved globe to go back to.
      this.#restore();
      return Promise.resolve();
    }
    return this.#fly("leaving");
  }

  #reset(observer: Observer): void {
    this.#setObserver(observer);
    this.#aim = { azimuth: defaultAzimuth(observer), pitch: DEFAULT_PITCH, roll: 0 };
    this.#fovy = DEFAULT_FOVY;
  }

  #setObserver(observer: Observer): void {
    this.#observer = observer;
    Cartographic.fromDegrees(observer.lon, observer.lat, 0, this.#observerCartographic);
    // A different place has a different ground under it, and a different frame.
    this.#groundHeight = 0;
    this.#frame = undefined;
  }

  /** Fly the one path, forwards to enter and backwards to leave. */
  #fly(phase: "entering" | "leaving"): Promise<void> {
    const previous = this.#flight;
    this.#phase = phase;

    const durationMs = flightDuration();
    if (durationMs <= 0) {
      // Reduced motion asked for the cut this replaced, so give exactly that
      // rather than a brisk version of the flight.
      this.#flight = undefined;
      previous?.finish();
      if (phase === "leaving") {
        this.#restore();
      } else {
        this.#phase = "live";
      }
      return Promise.resolve();
    }

    // Turning around resumes the progress already made rather than starting
    // over: the path is the one thing both directions share, so playing it the
    // other way from here is exactly retracing the trip, and the camera carries
    // on from where it is instead of snapping to an end it is nowhere near.
    const covered = previous ? CesiumMath.clamp((performance.now() - previous.startedAt) / previous.durationMs, 0, 1) : 1;
    const path: FlightPath = previous?.path ?? { from: this.#savedPose(), to: this.#sky, over: this.#over };
    this.#flight = beginFlight(path, phase === "leaving", durationMs, durationMs * (1 - covered));
    // After the new flight is in place: whoever was awaiting the old one checks
    // where things stand the moment this resolves.
    previous?.finish();
    return this.#flight.finished;
  }

  /** The globe pose to return to. Only ever called with `#saved` present. */
  #savedPose(): Pose {
    return this.#saved?.pose ?? this.#cameraPose();
  }

  #land(): void {
    const flight = this.#flight;
    this.#flight = undefined;
    if (this.#phase === "leaving") {
      this.#restore();
    } else {
      this.#phase = "live";
    }
    flight?.finish();
  }

  /** Put the globe back exactly as it was found, and stop touching the camera. */
  #restore(): void {
    const saved = this.#saved;
    // Cesium's Event defers removals raised from inside a dispatch, so this is
    // safe even though the landing frame is itself a preRender callback.
    this.#removePreRender?.();
    this.#removePreRender = undefined;
    this.#flight = undefined;
    this.#saved = undefined;
    this.#observer = undefined;
    this.#frame = undefined;
    this.#phase = "off";
    if (!saved) {
      return;
    }

    const { camera, screenSpaceCameraController: controller } = this.#scene;
    camera.lookAtTransform(Matrix4.IDENTITY);
    Cartesian3.clone(saved.pose.position, camera.position);
    Cartesian3.clone(saved.pose.direction, camera.direction);
    Cartesian3.clone(saved.pose.up, camera.up);
    Cartesian3.clone(saved.pose.right, camera.right);
    // The saved `fov` rather than the pose's vertical angle: this is the number
    // that was taken, and putting it back is not a question of aspect ratio.
    if (camera.frustum instanceof PerspectiveFrustum && !Number.isNaN(saved.fov)) {
      camera.frustum.fov = saved.fov;
    }
    controller.enableInputs = saved.enableInputs;
    controller.enableCollisionDetection = saved.enableCollisionDetection;
    this.#scene.requestRenderMode = saved.requestRenderMode;
  }

  #aspectRatio(): number {
    const { clientWidth, clientHeight } = this.#scene.canvas;
    return clientHeight > 0 ? clientWidth / clientHeight : 1;
  }

  /** Where the camera is right now, as a flight endpoint. */
  #cameraPose(): Pose {
    const { camera } = this.#scene;
    const fov = (camera.frustum instanceof PerspectiveFrustum ? camera.frustum.fov : undefined) ?? Number.NaN;
    return {
      position: Cartesian3.clone(camera.position, new Cartesian3()),
      direction: Cartesian3.clone(camera.direction, new Cartesian3()),
      up: Cartesian3.clone(camera.up, new Cartesian3()),
      right: Cartesian3.clone(camera.right, new Cartesian3()),
      // A frustum with no `fov` gives the flight nothing to interpolate, so it
      // starts at the angle it will end on and only the pose moves.
      fovy: Number.isNaN(fov) ? this.#fovy : CesiumMath.toDegrees(fovyFromFov(fov, this.#aspectRatio())),
    };
  }

  /**
   * The pose the aim asks for, written into `#sky`, and the same aim tipped all
   * the way down, written into `#over`. Refreshes the ground and the frame.
   */
  #skyPose(observer: Observer): Pose {
    const pose = this.#sky;

    // Stand on the ground rather than on the ellipsoid, which is hundreds of
    // metres out in the mountains. The last believable answer is kept, so an
    // implausible one — which is how a missing tile reports itself — leaves the
    // camera where it was instead of dropping it through the surface.
    const measured = this.#scene.globe.getHeight(this.#observerCartographic);
    if (isPlausibleGroundHeight(measured) && measured !== this.#groundHeight) {
      this.#groundHeight = measured;
      this.#frame = undefined;
    }
    Cartesian3.fromDegrees(observer.lon, observer.lat, this.#groundHeight + EYE_HEIGHT, undefined, pose.position);
    // Built from where the observer stands, never from `camera.position`, which
    // during a flight is somewhere over the ocean on the way here.
    this.#frame ??= observerFrame(pose.position);

    const enu = Transforms.eastNorthUpToFixedFrame(pose.position, undefined, new Matrix4());
    const rotation = Matrix4.getMatrix3(enu, new Matrix3());
    this.#orient(rotation, this.#aim, pose);
    pose.fovy = this.#fovy;

    // Straight down at the observer's feet, on the same azimuth and roll — the
    // attitude the descent aims with and the one the rise starts from. Built
    // through `skyBasis` like every other attitude here rather than as some
    // convenient nadir, because that is what makes the rise a pitch sweep from
    // -90° and nothing else: no roll creeps in, and `skyBasis` is continuous
    // through straight down, so -90° is an aim like any other.
    Cartesian3.clone(pose.position, this.#over.position);
    this.#orient(rotation, { ...this.#aim, pitch: -90 }, this.#over);
    return pose;
  }

  /** An east-north-up aim written into a pose, in world coordinates. */
  #orient(enuToFixed: Matrix3, aim: Aim, into: Pose): void {
    const { direction, up, right } = skyBasis(aim);
    Matrix3.multiplyByVector(enuToFixed, direction, into.direction);
    Matrix3.multiplyByVector(enuToFixed, up, into.up);
    Matrix3.multiplyByVector(enuToFixed, right, into.right);
  }

  #assign(pose: Pose): void {
    const { camera } = this.#scene;
    Cartesian3.clone(pose.position, camera.position);
    Cartesian3.clone(pose.direction, camera.direction);
    Cartesian3.clone(pose.up, camera.up);
    Cartesian3.clone(pose.right, camera.right);
    if (camera.frustum instanceof PerspectiveFrustum) {
      camera.frustum.fov = fovFromFovy(CesiumMath.toRadians(pose.fovy), this.#aspectRatio());
    }
  }

  #apply(): void {
    const observer = this.#observer;
    if (!observer || this.#phase === "off") {
      return;
    }

    // Computed even while leaving, and even though the camera is elsewhere: it
    // is what keeps `frame` answerable for as long as the view is active.
    const sky = this.#skyPose(observer);
    const flight = this.#flight;
    if (!flight) {
      this.#assign(sky);
      return;
    }

    const progress = (performance.now() - flight.startedAt) / flight.durationMs;
    // Leaving runs the same path from the far end, so the trip out retraces the
    // trip in exactly: look down at your feet, take off, and swing away.
    this.#assign(flightPose(flight.path, flight.reverse ? 1 - progress : progress, this.#blended));
    if (progress >= 1) {
      this.#land();
    }
  }
}

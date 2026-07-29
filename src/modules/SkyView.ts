// The sky view: the app's own camera, parked on the ground at the observer and
// aimed upward, so the satellites the globe already draws are seen from below.
//
// This module owns the camera and nothing else. It takes an observer and an aim
// and produces a camera basis; resolving who the observer is, and stopping the
// other things that want to drive the camera, belong to the caller
// (src/modules/sceneSync.ts). Rationale: docs/adr/0003-sky-view.md.
//
// Two Cesium behaviours shape the implementation:
//
//   - `camera.setView` cannot express this. It converts direction/up back into
//     heading/pitch/roll, and `getHeading` switches formula within EPSILON3 of
//     straight up — above about 87.4° of elevation the roll comes back wrong by
//     up to 180°, which mirrors the whole sky. So the basis is assigned
//     directly and Cesium is kept out of Euler angles entirely.
//   - `ScreenSpaceCameraController` runs its collision detection *outside* the
//     `enableInputs` check, so clearing that flag alone still leaves
//     `adjustHeightForTerrain` free to lift the camera off the observer on any
//     frame it thinks it moved. Both flags come off.

import { Cartesian3, Cartographic, Math as CesiumMath, Matrix3, Matrix4, PerspectiveFrustum, type Scene, SceneMode, Transforms } from "@cesium/engine";

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

interface SavedState {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  right: Cartesian3;
  fov: number;
  requestRenderMode: boolean;
  enableInputs: boolean;
  enableCollisionDetection: boolean;
}

export class SkyView {
  #scene: Scene;

  // Present exactly while the view is active, and the record of what has to be
  // put back. Restoring only what was actually changed is what lets the sky
  // view coexist with `?bg=false`, which has already destroyed the sky objects
  // a blanket restore would try to bring back.
  #saved: SavedState | undefined;

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

  get active(): boolean {
    return this.#saved !== undefined;
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

  enter(observer: Observer): void {
    if (this.active) {
      // Re-entering with a different observer is a move, not a second entry:
      // the saved globe state is the one from the original entry.
      this.#setObserver(observer);
      this.#apply();
      return;
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
      position: Cartesian3.clone(camera.position, new Cartesian3()),
      direction: Cartesian3.clone(camera.direction, new Cartesian3()),
      up: Cartesian3.clone(camera.up, new Cartesian3()),
      right: Cartesian3.clone(camera.right, new Cartesian3()),
      fov: (camera.frustum instanceof PerspectiveFrustum ? camera.frustum.fov : undefined) ?? Number.NaN,
      requestRenderMode: this.#scene.requestRenderMode,
      enableInputs: controller.enableInputs,
      enableCollisionDetection: controller.enableCollisionDetection,
    };

    this.#setObserver(observer);
    this.#aim = { azimuth: defaultAzimuth(observer), pitch: DEFAULT_PITCH, roll: 0 };
    this.#fovy = DEFAULT_FOVY;

    // A leftover reference frame — from `jumpTo`, or from tracking — would
    // reinterpret every vector assigned below.
    camera.lookAtTransform(Matrix4.IDENTITY);
    controller.enableInputs = false;
    controller.enableCollisionDetection = false;
    // The camera is driven from outside Cesium's own input handling, so there
    // is nothing for request-render mode to notice.
    this.#scene.requestRenderMode = false;

    // Re-asserted every frame rather than set once: the ground height under the
    // observer is only known after a render, the viewport aspect can change at
    // any time, and anything else that grabs the camera loses on the next frame.
    this.#removePreRender = this.#scene.preRender.addEventListener(() => this.#apply());
    this.#apply();
  }

  exit(): void {
    const saved = this.#saved;
    if (!saved) {
      return;
    }
    this.#removePreRender?.();
    this.#removePreRender = undefined;
    this.#saved = undefined;
    this.#observer = undefined;
    this.#frame = undefined;

    const { camera, screenSpaceCameraController: controller } = this.#scene;
    camera.lookAtTransform(Matrix4.IDENTITY);
    Cartesian3.clone(saved.position, camera.position);
    Cartesian3.clone(saved.direction, camera.direction);
    Cartesian3.clone(saved.up, camera.up);
    Cartesian3.clone(saved.right, camera.right);
    if (camera.frustum instanceof PerspectiveFrustum && !Number.isNaN(saved.fov)) {
      camera.frustum.fov = saved.fov;
    }
    controller.enableInputs = saved.enableInputs;
    controller.enableCollisionDetection = saved.enableCollisionDetection;
    this.#scene.requestRenderMode = saved.requestRenderMode;
  }

  #setObserver(observer: Observer): void {
    this.#observer = observer;
    Cartographic.fromDegrees(observer.lon, observer.lat, 0, this.#observerCartographic);
    // A different place has a different ground under it, and a different frame.
    this.#groundHeight = 0;
    this.#frame = undefined;
  }

  #apply(): void {
    const observer = this.#observer;
    if (!observer || !this.active) {
      return;
    }
    const { camera } = this.#scene;

    // Stand on the ground rather than on the ellipsoid, which is hundreds of
    // metres out in the mountains. The last believable answer is kept, so an
    // implausible one — which is how a missing tile reports itself — leaves the
    // camera where it was instead of dropping it through the surface.
    const measured = this.#scene.globe.getHeight(this.#observerCartographic);
    if (isPlausibleGroundHeight(measured) && measured !== this.#groundHeight) {
      this.#groundHeight = measured;
      this.#frame = undefined;
    }
    Cartesian3.fromDegrees(observer.lon, observer.lat, this.#groundHeight + EYE_HEIGHT, undefined, camera.position);
    this.#frame ??= observerFrame(camera.position);

    const enu = Transforms.eastNorthUpToFixedFrame(camera.position, undefined, new Matrix4());
    const rotation = Matrix4.getMatrix3(enu, new Matrix3());
    const { direction, up, right } = skyBasis(this.#aim);
    Matrix3.multiplyByVector(rotation, direction, camera.direction);
    Matrix3.multiplyByVector(rotation, up, camera.up);
    Matrix3.multiplyByVector(rotation, right, camera.right);

    if (camera.frustum instanceof PerspectiveFrustum) {
      const { clientWidth, clientHeight } = this.#scene.canvas;
      const aspectRatio = clientHeight > 0 ? clientWidth / clientHeight : 1;
      camera.frustum.fov = fovFromFovy(CesiumMath.toRadians(this.#fovy), aspectRatio);
    }
  }
}

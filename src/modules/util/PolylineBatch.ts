// One polyline primitive that many satellites' orbit lines are drawn into.
//
// Thousands of separate polylines is thousands of draw calls, so the lines are
// merged into a single Primitive and that Primitive is rebuilt whenever the set
// changes. Rebuilding is asynchronous and the scene must not be morphed while a
// build is in flight, which is what `settled()` is for.
//
// Two batches exist, and the frame is what separates them:
//
// - **inertial** — the Orbit component. The ellipse is fixed in inertial space,
//   so the whole primitive is re-oriented by a model matrix twice a second and
//   the geometry itself only has to be rebuilt when the membership changes.
// - **fixed** — the Orbit track component. An Earth-relative track is not a
//   rigid transform of itself as time passes, so there is no matrix that keeps
//   it current; instead the owner re-supplies geometry periodically through
//   `replace`, and the coalescing window collapses those thousands of swaps into
//   one rebuild. See SatelliteManager's track refresh.
//
// This used to be four `static` fields on CesiumComponentCollection, reached
// through `this.constructor` from instance methods and re-exported two levels up
// as `SatelliteManager.pendingUpdate` so CesiumController could busy-poll it in a
// requestAnimationFrame loop. Statics on a base class are module state with extra
// steps: the geometry array was mutated in place in one method and reassigned in
// another (installing an own static on the subclass that shadowed the base's),
// which only worked because exactly one subclass ever created a GeometryInstance.

import { type GeometryInstance, type JulianDate, Matrix4, PolylineColorAppearance, Primitive, SceneMode, Transforms, defined } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

/** Ticks to coalesce over, so a hundred satellites arriving cost one rebuild. */
const COALESCE_TICKS = 30;

/** How often the batch is re-oriented into the inertial frame, in seconds. */
const FRAME_UPDATE_SECONDS = 0.5;

/**
 * Which frame the geometries handed to this batch are expressed in — and so
 * whether a model matrix can keep them current. See the note at the top.
 */
export type BatchFrame = "inertial" | "fixed";

export class PolylineBatch {
  #viewer: Viewer;

  readonly #frame: BatchFrame;

  #geometries: GeometryInstance[] = [];

  #primitive: Primitive | undefined;

  /** A rebuild is queued and waiting out the coalescing window. */
  #scheduled = false;

  /** A Primitive is being built and is not in the scene yet. */
  #building = false;

  #settledWaiters: Array<() => void> = [];

  constructor(viewer: Viewer, frame: BatchFrame = "inertial") {
    this.#viewer = viewer;
    this.#frame = frame;
    if (frame === "inertial") {
      // Permanent, and a no-op while there is no batch. The orbits are drawn in the
      // inertial frame, so the whole primitive is re-oriented rather than each orbit
      // being recomputed.
      CesiumCallbackHelper.createPeriodicTimeCallback(viewer, FRAME_UPDATE_SECONDS, (time) => this.#applyInertialFrame(time));
    }
  }

  /** Whether a rebuild is queued or in flight. */
  get pending(): boolean {
    return this.#scheduled || this.#building;
  }

  /** How many geometries are in the batch. What a rebuild costs is a function of this. */
  get size(): number {
    return this.#geometries.length;
  }

  add(geometry: GeometryInstance): void {
    this.#geometries.push(geometry);
    this.#schedule();
  }

  remove(geometry: GeometryInstance): void {
    this.#geometries = this.#geometries.filter((candidate) => candidate !== geometry);
    this.#schedule();
  }

  /**
   * Swap one member's geometry for a freshly built one.
   *
   * A remove followed by an add would do the same thing, but this is the call a
   * periodic refresh makes once per satellite per cycle, and at five thousand
   * satellites the difference between one array pass and two is worth having.
   * More to the point it says what it means: the batch's membership has not
   * changed, only the shape of one line in it.
   *
   * Returns false when `previous` is not a member — a satellite whose component
   * was disabled between the refresh being scheduled and it running — so the
   * caller can drop the geometry it just built rather than leaking it into a
   * batch that no longer wants it.
   */
  replace(previous: GeometryInstance, next: GeometryInstance): boolean {
    const index = this.#geometries.indexOf(previous);
    if (index === -1) {
      return false;
    }
    this.#geometries[index] = next;
    this.#schedule();
    return true;
  }

  /**
   * Resolves once the batch matches the geometries it has been given.
   *
   * The caller that needs this is the scene morph: suppressing the Orbit
   * component drops every geometry, and morphing before the batch has caught up
   * would rebuild it into the projection being left behind.
   */
  settled(): Promise<void> {
    if (!this.pending) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#settledWaiters.push(resolve);
    });
  }

  #resolveSettled(): void {
    const waiters = this.#settledWaiters;
    this.#settledWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  #schedule(): void {
    if (this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    const stop = CesiumCallbackHelper.createPeriodicTickCallback(this.#viewer, COALESCE_TICKS, () => {
      // A build is still in flight; keep the window open and try again.
      if (this.#building) {
        return;
      }
      stop();
      this.#scheduled = false;
      if (this.#geometries.length === 0) {
        this.#clear();
        this.#resolveSettled();
        return;
      }
      this.#build();
    });
  }

  #clear(): void {
    if (!this.#primitive) {
      return;
    }
    this.#viewer.scene.primitives.remove(this.#primitive);
    this.#primitive = undefined;
    this.#viewer.scene.requestRender();
  }

  #build(): void {
    this.#building = true;
    const primitive = new Primitive({
      geometryInstances: this.#geometries,
      appearance: new PolylineColorAppearance(),
    });

    // Drive the primitive through its creation states by hand, so the finished
    // one replaces the old one in a single frame rather than the scene showing a
    // gap while Cesium builds it.
    let lastState = -1;
    const readyCallback = this.#viewer.clock.onTick.addEventListener(() => {
      if (!primitive.ready) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (primitive as any)._state;
        if (state !== lastState) {
          lastState = state;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (primitive as any).update(this.#viewer.scene.frameState);
        }
        return;
      }
      // Oriented before it goes in, so it is never drawn a frame behind the
      // batch it is replacing.
      this.#orient(primitive, this.#viewer.clock.currentTime);
      this.#clear();
      this.#viewer.scene.primitives.add(primitive);
      this.#primitive = primitive;
      this.#viewer.scene.requestRender();
      this.#building = false;
      readyCallback();
      if (!this.pending) {
        this.#resolveSettled();
      }
    });
  }

  #applyInertialFrame(time: JulianDate): void {
    if (this.#primitive) {
      this.#orient(this.#primitive, time);
    }
  }

  /**
   * `modelMatrix` in the inertial frame is only supported in 3D — outside it,
   * Cesium throws from inside the render loop — so the identity matrix stands in,
   * and the periodic update puts the rotation back on return to 3D.
   *
   * A fixed-frame batch is already in the frame it is drawn in and needs no
   * matrix at all.
   */
  #orient(primitive: Primitive, time: JulianDate): void {
    if (this.#frame === "fixed") {
      return;
    }
    if (this.#viewer.scene.mode !== SceneMode.SCENE3D) {
      primitive.modelMatrix = Matrix4.IDENTITY;
      return;
    }
    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time);
    if (defined(icrfToFixed)) {
      primitive.modelMatrix = Matrix4.fromRotationTranslation(icrfToFixed);
    }
  }
}

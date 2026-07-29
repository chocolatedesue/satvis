// The path the camera takes between the globe and the sky view.
//
// Entering used to be a cut: the camera was above the globe on one frame and
// standing on the ground under the observer on the next. The two pictures share
// so little that it read as arriving somewhere else rather than as the same
// world seen from a different place — which is precisely the claim the sky view
// is built on (docs/adr/0003-sky-view.md).
//
// Interpolating the two end poses is not enough on its own to make that claim.
// Blended straight, the attitude reaches sky-like within a few hundred
// milliseconds, the globe leaves the frame, and the rest of the descent is spent
// looking at empty sky while the position quietly travels — a flight that shows
// the departure and the arrival and nothing about the trip between them. So the
// flight is drawn in three legs against one clock:
//
//   1. **Lock on.** The view swings from wherever it was onto the destination.
//   2. **Descend.** The destination is held at the centre of the screen and grows
//      as the camera closes on it — the leg that answers "where are we going" —
//      coming to rest directly overhead, looking down at it.
//   3. **Rise.** The camera drops the last of the way and stands there, while the
//      view sweeps up off the ground, past the horizon, to the aim.
//
// Leaving is this played backwards, so the two are the same movement and the
// same code, and a switch back mid-flight is a change of sign rather than a
// second flight (see `SkyView`).
//
// Kept out of SkyView, and free of the scene, because it is arithmetic: the
// endpoints are camera poses and the answer depends on nothing else. That is
// also what makes the parts worth doubting — the great circle, an orientation
// blend that must not flip halfway, and an aim that must stay defined when the
// camera is standing on the very point it is aiming at — testable without a
// viewer.

import { Cartesian3, EasingFunction, Math as CesiumMath, Matrix3, Quaternion } from "@cesium/engine";

/** A camera pose in world coordinates, with the vertical angle it is seen through. */
export interface Pose {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  right: Cartesian3;
  /** Vertical field of view in degrees — the sky view's unit, never Cesium's `fov`. */
  fovy: number;
}

/** A pose to be written into. Every field is overwritten before it is read. */
export const newPose = (): Pose => ({
  position: new Cartesian3(),
  direction: new Cartesian3(),
  up: new Cartesian3(),
  right: new Cartesian3(),
  fovy: 0,
});

/** The poses a flight is drawn between. */
export interface FlightPath {
  /** Where the camera was on the globe, and the attitude it had there. */
  from: Pose;
  /** The observer, and the aim the view ends on. */
  to: Pose;
  /**
   * Standing at the observer and looking straight down, oriented as `to` is.
   *
   * The attitude the descent aims with and the one the rise starts from, so it
   * has to be the aim tipped to -90° rather than any convenient nadir: built that
   * way, the whole third leg is a pitch sweep and nothing else — no roll creeps
   * in, and the view arrives facing the direction it spent the descent facing.
   * Only its basis is read; its position and field of view are ignored.
   */
  over: Pose;
}

/**
 * How long the flight between the globe and the ground takes.
 *
 * Cesium's own camera flights run around this long. Three legs need the room:
 * shorter and the descent and the rise blur into one movement, longer and
 * switching view modes starts to feel like something to wait out.
 */
export const FLIGHT_MS = 2200;

/**
 * When the view has finished swinging onto the destination, as a fraction of the
 * flight. Early, because the swing exists to answer "where is this going" before
 * the descent rather than during it — and because the position has barely moved
 * by then, so the swing reads as a pan and not as a lurch.
 */
export const LOCK_ON = 0.3;

/**
 * How much of the flight the rise takes. It sweeps about 120° — from the ground
 * at the observer's feet, past the horizon, up to the default aim — and needs the
 * room, because this is the leg that says the view has arrived somewhere.
 */
export const TIP_UP = 0.45;

/**
 * When the camera reaches the ground: before the rise ends, deliberately. Landing
 * and then looking up is the order a person would do it in, and separating the
 * two keeps either from reading as a side effect of the other.
 */
export const TOUCHDOWN = 0.8;

/**
 * Cesium's own default for a camera flight, so each leg feels like the rest of
 * the app's camera movement. Its flat ends are also what make the joins between
 * legs invisible: every leg arrives and leaves at zero rate.
 */
const EASING = EasingFunction.QUINTIC_IN_OUT;

/** Eased progress from raw progress, clamped — which is also how a leg is scheduled. */
export const easeFlight = (t: number): number => EASING(CesiumMath.clamp(t, 0, 1));

/**
 * Zero for anyone who has asked for less motion, which restores the cut this
 * replaced — the honest reading of that request, and not a shorter flight.
 */
export const flightDuration = (): number => (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : FLIGHT_MS);

/** Closer than this to the destination and there is no line of sight left to aim along. */
const ARRIVED_METRES = 1;

const scratchFromUnit = new Cartesian3();
const scratchToUnit = new Cartesian3();
const scratchAxis = new Cartesian3();
const scratchRotation = new Matrix3();
const scratchQuaternion = new Quaternion();

/**
 * Move one position to another the long way round the planet rather than
 * straight through it.
 *
 * `sweep` is how far round the great circle and `drop` how far down: two
 * fractions rather than one, because the flight is meant to come to rest
 * directly over the destination and only then land on it. That is not only the
 * clearer picture — a swoop that arrives along its own tangent reaches the
 * ground travelling sideways, and the aim tracking it would swing hard through
 * the last few metres.
 *
 * Interpolating the distance from the geocentre separately is also why there is
 * no arc-height fudge here: it stays inside the interval between the two
 * endpoints' radii, and both of those are above the ground, so no fraction can
 * put the camera underground.
 */
export function flightPosition(from: Cartesian3, to: Cartesian3, sweep: number, drop: number, result: Cartesian3): Cartesian3 {
  const fromRadius = Cartesian3.magnitude(from);
  const toRadius = Cartesian3.magnitude(to);
  if (fromRadius === 0 || toRadius === 0) {
    // The geocentre has no direction to rotate, so there is no great circle to
    // take. Unreachable from a real camera, and a straight line is the answer.
    return Cartesian3.lerp(from, to, drop, result);
  }
  const radius = CesiumMath.lerp(fromRadius, toRadius, drop);
  const fromUnit = Cartesian3.divideByScalar(from, fromRadius, scratchFromUnit);
  const toUnit = Cartesian3.divideByScalar(to, toRadius, scratchToUnit);

  // atan2 of the cross and dot magnitudes, so this stays accurate at both ends
  // of the range where an acos would not.
  const angle = Cartesian3.angleBetween(fromUnit, toUnit);
  if (angle < CesiumMath.EPSILON7) {
    return Cartesian3.multiplyByScalar(fromUnit, radius, result);
  }
  const axis = turnAxis(fromUnit, toUnit, scratchAxis);

  Matrix3.fromQuaternion(Quaternion.fromAxisAngle(axis, angle * sweep, scratchQuaternion), scratchRotation);
  Matrix3.multiplyByVector(scratchRotation, fromUnit, result);
  return Cartesian3.multiplyByScalar(result, radius, result);
}

/**
 * A unit axis to turn `from` onto `to` about.
 *
 * Antipodal inputs have no such axis — every plane through the pair contains the
 * geocentre, so the cross product vanishes and no rotation is picked out. Any
 * perpendicular is then as good a route as another.
 */
function turnAxis(from: Cartesian3, to: Cartesian3, result: Cartesian3): Cartesian3 {
  Cartesian3.cross(from, to, result);
  if (Cartesian3.magnitudeSquared(result) < CesiumMath.EPSILON14) {
    Cartesian3.cross(from, Cartesian3.mostOrthogonalAxis(from, scratchToUnit), result);
  }
  return Cartesian3.normalize(result, result);
}

/**
 * A camera's attitude as a rotation, so two of them can be blended.
 *
 * The columns are right, up and backwards, because a Cesium camera looks down
 * its own negative z — and because the three have to make a proper rotation for
 * the conversion to mean anything. Going through a quaternion rather than
 * interpolating the three vectors and re-orthogonalising is what keeps the
 * blend a rotation at every step: three separately-lerped unit vectors are not
 * orthonormal in between, and the camera would shear before it was fixed up.
 */
export function poseRotation(pose: Pick<Pose, "direction" | "up" | "right">, result: Quaternion): Quaternion {
  const { direction: d, up: u, right: r } = pose;
  // Matrix3's constructor is row-major, so this reads across the rows.
  return Quaternion.fromRotationMatrix(new Matrix3(r.x, u.x, -d.x, r.y, u.y, -d.y, r.z, u.z, -d.z), result);
}

const scratchLine = new Cartesian3();
const scratchAimAxis = new Cartesian3();
const scratchOverRotation = new Quaternion();
const scratchTurn = new Quaternion();
const scratchAimed = new Quaternion();
const scratchFromRotation = new Quaternion();
const scratchToRotation = new Quaternion();
const scratchLocked = new Quaternion();
const scratchBlended = new Quaternion();
const scratchBasis = new Matrix3();

/**
 * The attitude that puts the destination at the centre of the screen, seen from
 * `eye`.
 *
 * Built by turning the straight-down attitude onto the line of sight, not by
 * crossing the view axis with an up vector. That is the whole trick: a look-at
 * built from a cross product has no answer when the camera is directly overhead —
 * which is exactly where this flight ends — because the two vectors it crosses are
 * parallel there. Turning `over` instead makes the overhead case the identity
 * rotation, so the aim reaches straight-down smoothly and stays defined once the
 * camera is standing on the destination itself and there is no line of sight left.
 */
function aimedRotation(over: Pose, target: Cartesian3, eye: Cartesian3, result: Quaternion): Quaternion {
  const nadir = poseRotation(over, scratchOverRotation);
  const line = Cartesian3.subtract(target, eye, scratchLine);
  const distance = Cartesian3.magnitude(line);
  if (distance < ARRIVED_METRES) {
    return Quaternion.clone(nadir, result);
  }
  Cartesian3.divideByScalar(line, distance, line);

  const angle = Cartesian3.angleBetween(over.direction, line);
  if (angle < CesiumMath.EPSILON7) {
    return Quaternion.clone(nadir, result);
  }
  const turn = Quaternion.fromAxisAngle(turnAxis(over.direction, line, scratchAimAxis), angle, scratchTurn);
  // `turn` second: the nadir attitude is applied first and then swung in world
  // space, which is what leaves the destination on the view axis.
  return Quaternion.multiply(turn, nadir, result);
}

/**
 * The camera pose at raw progress `t` through the flight — unclamped and uneased,
 * because each leg schedules itself off it. `result` must not be a member of `path`.
 */
export function flightPose(path: FlightPath, t: number, result: Pose): Pose {
  const { from, to, over } = path;

  // The camera stops travelling over the ground exactly as the rise begins, and
  // spends the rise dropping onto the destination and then standing on it. That
  // ordering is what makes the aim below well behaved as well as legible: from
  // the moment the rise starts the camera is directly overhead, so the aim is
  // already straight down and the rise has nothing left to do but change pitch.
  const overhead = easeFlight(t / (1 - TIP_UP));
  const arrival = easeFlight(t / TOUCHDOWN);
  flightPosition(from.position, to.position, overhead, arrival, result.position);
  // Widening is part of the arrival, not something laid over the rise.
  result.fovy = CesiumMath.lerp(from.fovy, to.fovy, arrival);

  // The two attitude legs never overlap — the swing is finished long before the
  // rise starts — so between them the aim stands alone and the destination is
  // pinned to the centre of the screen for the whole descent.
  const aimed = aimedRotation(over, to.position, result.position, scratchAimed);
  const locked = Quaternion.slerp(poseRotation(from, scratchFromRotation), aimed, easeFlight(t / LOCK_ON), scratchLocked);
  const blended = Quaternion.slerp(locked, poseRotation(to, scratchToRotation), easeFlight((t - (1 - TIP_UP)) / TIP_UP), scratchBlended);

  // slerp falls back to a plain lerp for nearly-equal rotations, which shortens
  // the quaternion, and `fromQuaternion` wants a unit one.
  Matrix3.fromQuaternion(Quaternion.normalize(blended, blended), scratchBasis);
  Matrix3.getColumn(scratchBasis, 0, result.right);
  Matrix3.getColumn(scratchBasis, 1, result.up);
  Matrix3.getColumn(scratchBasis, 2, result.direction);
  Cartesian3.negate(result.direction, result.direction);
  return result;
}

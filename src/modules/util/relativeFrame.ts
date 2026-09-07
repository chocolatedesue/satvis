// Where one satellite is, as seen from another.
//
// Everything else in this folder answers questions in an Earth-centred frame,
// because that is the frame a globe draws and a ground station listens in. A
// formation is the one thing that is invisible there: at the scale a globe is
// drawn, a kilometre-wide cluster is a single point, and the quantity worth
// reading — where each member sits relative to the reference — is a difference
// between two numbers that agree to seven digits.
//
// So a formation is read in the reference satellite's own frame, and there are
// two of them, which answer different questions:
//
//   - The **RIC frame** (radial / in-track / cross-track), rebuilt from the
//     reference's state at every instant. It rotates once per orbit with the
//     satellite. In it a bounded formation sits inside a fixed ellipse — twice as
//     wide along-track as it is tall — and never leaves it. This is the frame for
//     "is the formation holding": distances, link ranges, whether anything has
//     drifted.
//
//   - The **epoch frame**, which is the RIC basis captured once and then held
//     still while the satellite flies on. It does not rotate, so the same
//     formation appears to turn inside it, and the bounding ellipse turns with
//     it — flat, then upright, then flat again, twice per revolution. This is the
//     frame Google's Suncatcher figure is drawn in (its caption calls it
//     "non-rotating"), and the frame in which the shape cycle is a thing you can
//     see rather than a number you have to be told.
//
// Neither is a Cesium reference frame and neither needs to be: both are three
// unit vectors and three dot products, and they are the same arithmetic whether
// the positions arrived from satellite.js in kilometres or from a
// `GridPositionProperty` in metres. Nothing here converts units — offsets come
// back in whatever unit went in.

/** A vector, in whatever unit the caller is working in. */
export type Vec3 = readonly [number, number, number];

/** Radial out, along-track forward, cross-track completing the set. */
export interface RicBasis {
  radial: Vec3;
  alongTrack: Vec3;
  crossTrack: Vec3;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length === 0 ? [0, 0, 0] : [a[0] / length, a[1] / length, a[2] / length];
}

/**
 * The reference satellite's own axes, from its state.
 *
 * Built from the propagated position and velocity rather than from the elements
 * anyone believes it has, so a measurement taken in this frame says nothing about
 * the model that produced it: the propagator decides where the reference is and
 * which way it is going, and the offsets are read off that.
 *
 * Along-track is `crossTrack x radial` rather than the velocity direction. The
 * two agree exactly only for a circular orbit; taking the orbit normal first
 * keeps the basis orthonormal for any orbit, and keeps "along-track" meaning the
 * in-plane direction perpendicular to the radius, which is the one a formation's
 * geometry is quoted against.
 */
export function ricBasis(position: Vec3, velocity: Vec3): RicBasis {
  const radial = normalize(position);
  const crossTrack = normalize(cross(position, velocity));
  return { radial, alongTrack: cross(crossTrack, radial), crossTrack };
}

/**
 * A member's offset from the reference, resolved in a basis, as
 * `[radial, alongTrack, crossTrack]`.
 *
 * The basis is a parameter rather than recomputed here, which is the whole
 * distinction between the two frames above: pass the basis of the current instant
 * and the result is the RIC offset; pass a basis captured at epoch and the result
 * is the non-rotating one, in which the formation turns.
 */
export function offsetIn(basis: RicBasis, referencePosition: Vec3, memberPosition: Vec3): [number, number, number] {
  const offset: Vec3 = [memberPosition[0] - referencePosition[0], memberPosition[1] - referencePosition[1], memberPosition[2] - referencePosition[2]];
  return [dot(offset, basis.radial), dot(offset, basis.alongTrack), dot(offset, basis.crossTrack)];
}

/**
 * How far the formation reaches from its reference, in the plane of the orbit.
 *
 * The cross-track component is left out on purpose: a formation's stated radius
 * is the extent of its bounding ellipse, which is an in-plane object, and a
 * cluster given out-of-plane motion is quoted separately for it.
 */
export function inPlaneExtent(offsets: ReadonlyArray<readonly [number, number, number]>): number {
  return offsets.reduce((worst, [radial, alongTrack]) => Math.max(worst, Math.hypot(radial, alongTrack)), 0);
}

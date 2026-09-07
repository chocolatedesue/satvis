// Where a formation's members are, relative to their reference, right now.
//
// The one thing a globe cannot show. A formation is a kilometre or a hundred
// across and the Earth is twelve thousand, so at any camera height that frames
// the planet the whole cluster is a handful of pixels: correct, and unreadable.
// What is worth looking at is not where the formation *is* but what it is
// *doing*, and that is a picture with the reference satellite at the origin.
//
// It propagates the members itself rather than reading the positions the globe
// already has, for two reasons that both come down to the same thing — a
// formation is defined by its elements:
//
//   - **Frame.** The globe's positions are Earth-fixed, and an Earth-fixed
//     velocity is the orbital velocity plus the ground's, which at 550 km tilts
//     the along-track axis by about four degrees. The radial/along-track split
//     would be wrong by that much everywhere. SGP4 hands back TEME position *and*
//     velocity, which is the frame the split is defined in.
//   - **Independence.** A reader of the geometry should not depend on whether the
//     renderer happens to have built a component, or on which frame a camera mode
//     put the scene in. Twenty-nine `propagate` calls are microseconds; the
//     coupling would cost more than the arithmetic.
//
// Cesium-free, so the whole projection is exercised by the node-env suite rather
// than by looking at it.

import { propagate, type SatRec } from "satellite.js";

import { clusterFormationRecords, clusterLattice, clusterRadiusM, type ClusterFormationParams } from "./clusterFormation";
import { createSatrec } from "./gp";
import { offsetIn, ricBasis, type RicBasis, type Vec3 } from "./relativeFrame";

/** One member, placed. Offsets in metres. */
export interface FormationMember {
  /** Radial lattice index, positive outward. */
  i: number;
  /** Along-track lattice index, positive prograde. */
  j: number;
  /** Metres above or below the reference. */
  radial: number;
  /** Metres ahead of or behind it. */
  alongTrack: number;
  /** Metres out of its orbit plane. Zero for a coplanar formation. */
  crossTrack: number;
}

export interface FormationSnapshot {
  members: FormationMember[];
  /** The formation's stated radius, so a drawing can scale to the design rather than to the data. */
  radiusM: number;
  /**
   * How far the bounding ellipse has turned in the frame this was projected into,
   * in radians, or 0 when the frame is the rotating one.
   *
   * The ellipse is `±R` along-track by `±R/2` radial and fixed in the *rotating*
   * frame. Projected into a frame captured earlier it turns at the orbital rate,
   * which is the whole of the deformation a viewer sees — so a drawing needs this
   * angle and cannot get it from the members alone.
   */
  ellipseAngleRad: number;
}

/**
 * The satrecs for a formation, ready to propagate.
 *
 * Separate from the snapshot because building them parses element sets and a
 * caller redrawing at frame rate should do that once. The array is in lattice
 * order — `clusterLattice`'s order — so index 0 is the reference.
 */
export function formationSatrecs(params: ClusterFormationParams, epoch: Date): SatRec[] {
  return clusterFormationRecords(params, epoch).map(createSatrec);
}

function stateAt(satrec: SatRec, at: Date): { position: Vec3; velocity: Vec3 } | undefined {
  const state = propagate(satrec, at);
  if (!state?.position || !state.velocity) {
    return undefined;
  }
  return {
    position: [state.position.x, state.position.y, state.position.z],
    velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
  };
}

/**
 * The reference's own axes at an instant — the basis a snapshot is projected into.
 *
 * Exposed on its own because the two frames differ *only* in which instant this is
 * taken at, and that is the distinction worth making explicit at the call site
 * rather than hiding behind a boolean:
 *
 *   - the same instant as the snapshot gives the **rotating** frame, in which a
 *     bounded formation sits inside a fixed ellipse and never leaves it;
 *   - an earlier instant, held, gives the **non-rotating** frame, in which the
 *     ellipse turns and the formation is seen to deform — twice per orbit, which
 *     is the thing a formation is quoted for and the thing the rotating frame
 *     hides completely.
 */
export function formationBasis(satrecs: readonly SatRec[], at: Date): RicBasis | undefined {
  const reference = satrecs[0] && stateAt(satrecs[0], at);
  return reference ? ricBasis(reference.position, reference.velocity) : undefined;
}

/**
 * Every member's offset from the reference, in metres, in the given basis.
 *
 * `frameEpoch` is the instant the basis was taken at, and the only reason it is
 * passed as well as the basis: the bounding ellipse's angle is the reference's
 * own angular travel since then, which the basis alone cannot say.
 */
export function formationSnapshot(
  params: ClusterFormationParams,
  satrecs: readonly SatRec[],
  at: Date,
  basis: RicBasis,
  frameEpoch: Date,
  meanMotionRadPerSec: number,
): FormationSnapshot {
  const lattice = clusterLattice(params.rings);
  const reference = satrecs[0] && stateAt(satrecs[0], at);
  const members: FormationMember[] = [];
  if (reference) {
    for (const [index, [i, j]] of lattice.entries()) {
      const satrec = satrecs[index];
      const state = satrec && stateAt(satrec, at);
      if (!state) {
        continue;
      }
      const [radial, alongTrack, crossTrack] = offsetIn(basis, reference.position, state.position);
      // Kilometres in, metres out: element sets are quoted in km and formations in m.
      members.push({ i, j, radial: radial * 1000, alongTrack: alongTrack * 1000, crossTrack: crossTrack * 1000 });
    }
  }
  return {
    members,
    radiusM: clusterRadiusM(params),
    ellipseAngleRad: ((at.getTime() - frameEpoch.getTime()) / 1000) * meanMotionRadPerSec,
  };
}

/** Radians a second, for the ellipse angle. Derived from the same two-body value the records state. */
export function meanMotionRadPerSec(params: ClusterFormationParams): number {
  const EARTH_RADIUS_KM = 6378.135;
  const MU_KM3_S2 = 398600.8;
  const a = EARTH_RADIUS_KM + params.altitudeKm;
  return Math.sqrt(MU_KM3_S2 / (a * a * a));
}

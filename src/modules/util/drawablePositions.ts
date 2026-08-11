// The one answer to "will Cesium build geometry from these positions?".
//
// Every geometry constructor in Cesium runs its positions through
// `arrayRemoveDuplicates` and returns `undefined` if fewer than two survive;
// `PolylineGeometry.createGeometry` and `CorridorGeometry.createGeometry` both do.
// So counting positions does not answer the question.
// A geometry that comes back `undefined` still leaves its instance in the batch,
// `PrimitivePipeline.combineGeometry` fills `boundingSpheres[i]` only when the
// geometry exists, and `recomputeBoundingSpheres` then dereferences the hole that
// leaves — throwing inside `Scene.render`, which stops the render loop for the
// rest of the session.
//
// So callers ask this instead, and a `length < 2` check afterwards means what it
// looks like.

import { Cartesian3, Math as CesiumMath } from "@cesium/engine";

/**
 * The positions Cesium will keep: no holes, no consecutive duplicates.
 *
 * `EPSILON10` and consecutive-only comparison come from `arrayRemoveDuplicates`,
 * which is the test that has to be matched. It is a *relative* epsilon, so at
 * Earth-radius magnitudes the threshold is around a millimetre; only positions
 * that are the same point collapse.
 *
 * Corridors dedupe after projecting onto the ellipsoid, so two positions differing
 * only in altitude collapse there and not here. That needs purely radial motion
 * across a whole sampling interval, which no orbit has, and the case this exists
 * for is byte-identical anyway.
 */
export function drawablePositions(positions: readonly (Cartesian3 | undefined)[]): Cartesian3[] {
  const drawable: Cartesian3[] = [];
  for (const position of positions) {
    if (!position) {
      continue;
    }
    const previous = drawable[drawable.length - 1];
    if (previous && Cartesian3.equalsEpsilon(previous, position, CesiumMath.EPSILON10)) {
      continue;
    }
    drawable.push(position);
  }
  return drawable;
}

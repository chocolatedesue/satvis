import { Cartesian3, CorridorGeometry, Math as CesiumMath, PolylineGeometry } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { drawablePositions } from "./drawablePositions";

// Roughly on the ellipsoid, so the relative epsilon is exercised at the magnitudes
// the callers pass.
const SURFACE = new Cartesian3(6378137, 0, 0);

describe("drawablePositions", () => {
  test("keeps distinct positions in order", () => {
    const a = new Cartesian3(1e6, 0, 0);
    const b = new Cartesian3(0, 1e6, 0);
    expect(drawablePositions([a, b])).toEqual([a, b]);
  });

  test("drops holes", () => {
    const a = new Cartesian3(1e6, 0, 0);
    const b = new Cartesian3(0, 1e6, 0);
    expect(drawablePositions([undefined, a, undefined, b, undefined])).toEqual([a, b]);
  });

  // The case that stopped the render loop: outside the sample window
  // `GridPositionProperty` clamps to the window's edge, so two different times
  // answer with the same position.
  test("a held position collapses to one, so callers can see it is not a track", () => {
    expect(drawablePositions([SURFACE, SURFACE])).toHaveLength(1);
    expect(drawablePositions([SURFACE, SURFACE, SURFACE])).toHaveLength(1);
  });

  test("nothing usable is nothing, not a degenerate pair", () => {
    expect(drawablePositions([])).toEqual([]);
    expect(drawablePositions([undefined, undefined])).toEqual([]);
  });

  // Consecutive-only, matching `arrayRemoveDuplicates` with `wrapAround` false —
  // an orbit that returns to its start is a closed track, not a duplicate.
  test("only consecutive duplicates collapse", () => {
    const a = new Cartesian3(1e6, 0, 0);
    const b = new Cartesian3(0, 1e6, 0);
    expect(drawablePositions([a, b, a])).toEqual([a, b, a]);
  });

  // Cesium's epsilon is relative, so the threshold scales with magnitude. Sub-
  // millimetre apart at Earth radius is the same point; a metre is not.
  test("the epsilon is Cesium's, so real motion survives", () => {
    const near = Cartesian3.add(SURFACE, new Cartesian3(SURFACE.x * CesiumMath.EPSILON10 * 0.5, 0, 0), new Cartesian3());
    expect(drawablePositions([SURFACE, near])).toHaveLength(1);

    const metre = Cartesian3.add(SURFACE, new Cartesian3(1, 0, 0), new Cartesian3());
    expect(drawablePositions([SURFACE, metre])).toHaveLength(2);
  });
});

// Why `length < 2` is the threshold, checked against Cesium rather than remembered
// from it. If an upgrade ever makes a degenerate geometry build something instead
// of returning `undefined`, or moves the threshold off two, this fails and the
// guards above can be revisited.
describe("what Cesium does with the positions this module rejects", () => {
  const KM = 200000;
  const along = Cartesian3.add(SURFACE, new Cartesian3(0, KM, 0), new Cartesian3());

  test("a corridor from two of a point builds nothing", () => {
    const degenerate = CorridorGeometry.createGeometry(new CorridorGeometry({ positions: [SURFACE, SURFACE], width: 10000 }));
    expect(degenerate).toBeUndefined();

    const real = CorridorGeometry.createGeometry(new CorridorGeometry({ positions: [SURFACE, along], width: 10000 }));
    expect(real).toBeDefined();
  });

  test("a polyline from two of a point builds nothing", () => {
    const degenerate = PolylineGeometry.createGeometry(new PolylineGeometry({ positions: [SURFACE, SURFACE], width: 2 }));
    expect(degenerate).toBeUndefined();

    const real = PolylineGeometry.createGeometry(new PolylineGeometry({ positions: [SURFACE, along], width: 2 }));
    expect(real).toBeDefined();
  });
});

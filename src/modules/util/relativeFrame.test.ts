import { describe, expect, it } from "vitest";

import { inPlaneExtent, offsetIn, ricBasis, type Vec3 } from "./relativeFrame";

/** A circular orbit in the x-y plane, at radius 7000, moving +y at x = 7000. */
const position: Vec3 = [7000, 0, 0];
const velocity: Vec3 = [0, 7.5, 0];

describe("ricBasis", () => {
  it("points radial out, along-track forward and cross-track along the orbit normal", () => {
    const { radial, alongTrack, crossTrack } = ricBasis(position, velocity);
    expect(radial).toEqual([1, 0, 0]);
    expect(alongTrack[0]).toBeCloseTo(0, 12);
    expect(alongTrack[1]).toBeCloseTo(1, 12);
    expect(crossTrack[2]).toBeCloseTo(1, 12);
  });

  it("stays orthonormal when the velocity is not perpendicular to the radius", () => {
    // An eccentric orbit at any point but apsis: the velocity has a radial
    // component, and taking the orbit normal first is what keeps the basis square.
    const { radial, alongTrack, crossTrack } = ricBasis(position, [2, 7.5, 0]);
    for (const axis of [radial, alongTrack, crossTrack]) {
      expect(Math.hypot(...axis)).toBeCloseTo(1, 12);
    }
    expect(radial[0] * alongTrack[0] + radial[1] * alongTrack[1] + radial[2] * alongTrack[2]).toBeCloseTo(0, 12);
  });

  it("is all zeros for a degenerate state rather than NaN", () => {
    expect(ricBasis([0, 0, 0], [0, 0, 0]).radial).toEqual([0, 0, 0]);
  });
});

describe("offsetIn", () => {
  const basis = ricBasis(position, velocity);

  it("resolves an offset into radial, along-track and cross-track", () => {
    expect(offsetIn(basis, position, [7000.1, 0.2, 0.3])).toEqual([expect.closeTo(0.1, 9), expect.closeTo(0.2, 9), expect.closeTo(0.3, 9)]);
  });

  it("reports the reference as the origin", () => {
    expect(offsetIn(basis, position, position)).toEqual([0, 0, 0]);
  });

  it("turns the formation when the basis is held still and the reference moves on", () => {
    // A quarter orbit later the satellite is at (0, 7000) moving -x. A member one
    // kilometre *above* it is at (0, 7001) — radially out in the current frame,
    // but along the epoch frame's own along-track axis.
    const later: Vec3 = [0, 7000, 0];
    const member: Vec3 = [0, 7001, 0];
    const now = ricBasis(later, [-7.5, 0, 0]);
    expect(offsetIn(now, later, member)[0]).toBeCloseTo(1, 9);
    expect(offsetIn(basis, later, member)[1]).toBeCloseTo(1, 9);
  });
});

describe("inPlaneExtent", () => {
  it("measures the furthest member in the orbit plane, ignoring cross-track", () => {
    expect(inPlaneExtent([[3, 4, 1000]])).toBe(5);
    expect(inPlaneExtent([])).toBe(0);
  });
});

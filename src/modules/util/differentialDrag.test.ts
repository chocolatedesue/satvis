// The differential-drag law, pinned.
//
// Two things are worth asserting and only two. The t² is the whole character of
// the effect — every other term in the cluster model is a rate — so a refactor
// that turns it into a linear growth would still produce plausible-looking
// numbers and would be wrong about when a configuration dies. And the magnitudes
// against the two tolerances are the results the documentation quotes, so they
// are measured here rather than trusted.

import { describe, expect, it } from "vitest";

import { arcLengthM, ballisticCoefficient, densityAt, differentialDragDriftM, SCALE_HEIGHT_KM } from "./differentialDrag";

describe("differentialDragDriftM", () => {
  it("falls off with altitude, through the density", () => {
    // One scale height is a factor of e, and the drift is linear in ρ.
    const at550 = densityAt(550);
    const at615 = densityAt(550 + SCALE_HEIGHT_KM);
    expect(at615 / at550).toBeCloseTo(Math.exp(-1), 6);
  });

  it("grows as t², not as t — the only non-rate in the cluster model", () => {
    const hour = differentialDragDriftM(550, 0.011, 3600);
    const twoHours = differentialDragDriftM(550, 0.011, 7200);
    expect(twoHours / hour).toBeCloseTo(4, 6);
  });

  it("is linear in the ballistic-coefficient spread", () => {
    const one = differentialDragDriftM(550, 0.011, 3600);
    const two = differentialDragDriftM(550, 0.022, 3600);
    expect(two / one).toBeCloseTo(2, 6);
  });

  it("leaves a cross-shell cluster inside its 1° slip budget over 48 h", () => {
    // 10% disagreement between two members at moderate solar activity.
    const drift = differentialDragDriftM(550, ballisticCoefficient(0.05) * 0.1, 48 * 3600);
    expect(drift).toBeLessThan(arcLengthM(550, 1));
    expect(drift / arcLengthM(550, 1)).toBeLessThan(0.25);
  });

  it("disperses a 100 m formation past its own spacing within a few orbits", () => {
    // Same physics, a thousand times tighter tolerance. Five orbits at 650 km.
    const drift = differentialDragDriftM(650, ballisticCoefficient(0.05) * 0.1, 5 * 5864);
    expect(drift).toBeGreaterThan(100);
  });
});

import { Cartesian3, JulianDate, Matrix3, Transforms } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { fixedRotationAt, greenwichHourAngle } from "./temeToFixed";

// The whole point of this module is that it reproduces Cesium's
// `computeTemeToPseudoFixedMatrix` rather than approximating it, so every test here
// is a comparison against Cesium itself. Tolerances are in metres at orbital radius,
// which is the only unit in which "close enough" means anything.

const LEO_RADIUS = 6_871_000;
const GEO_RADIUS = 42_164_000;

/** Cesium's own answer for the same instant, as a fixed-frame position. */
function cesiumRotate(epochMs: number, teme: Cartesian3): Cartesian3 {
  const matrix = Transforms.computeTemeToPseudoFixedMatrix(JulianDate.fromDate(new Date(epochMs)), new Matrix3());
  return Matrix3.multiplyByVector(matrix, teme, new Cartesian3());
}

function ourRotate(epochMs: number, teme: Cartesian3): Cartesian3 {
  const rotation = fixedRotationAt(epochMs, { cos: 1, sin: 0 });
  return new Cartesian3(rotation.cos * teme.x + rotation.sin * teme.y, rotation.cos * teme.y - rotation.sin * teme.x, teme.z);
}

function deviationMetres(epochMs: number, teme: Cartesian3): number {
  return Cartesian3.magnitude(Cartesian3.subtract(ourRotate(epochMs, teme), cesiumRotate(epochMs, teme), new Cartesian3()));
}

describe("greenwichHourAngle", () => {
  test("agrees with Cesium's transform to well under a millimetre, across three years", () => {
    // A fixed pseudo-random spread rather than a handful of round numbers: the
    // failure this guards against is a branch or a rounding term that only bites at
    // particular times of day.
    let seed = 1_234_567;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const teme = new Cartesian3(LEO_RADIUS * 0.7, LEO_RADIUS * 0.5, LEO_RADIUS * 0.51);

    let worst = 0;
    for (let i = 0; i < 500; i += 1) {
      worst = Math.max(worst, deviationMetres(Date.UTC(2026, 0, 1) + Math.floor(next() * 3 * 365 * 86_400_000), teme));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  test("holds across the midnight and noon boundaries where the tabulation switches branch", () => {
    const teme = new Cartesian3(GEO_RADIUS * 0.9, GEO_RADIUS * 0.4, 0);
    // 43200 s into the Julian day is where the +/- half-day term flips, and midnight
    // is where secondsSinceMidnight wraps. Straddle both by a millisecond.
    for (const boundary of [Date.UTC(2026, 5, 17, 0, 0, 0), Date.UTC(2026, 5, 17, 12, 0, 0)]) {
      for (const offsetMs of [-1, 0, 1, -1000, 1000]) {
        expect(deviationMetres(boundary + offsetMs, teme)).toBeLessThan(1e-5);
      }
    }
  });

  test("is continuous across those boundaries", () => {
    // A branch that picked the wrong tabulation would show up as a step here rather
    // than as an outright wrong answer.
    const midnight = Date.UTC(2026, 5, 17, 0, 0, 0);
    const before = greenwichHourAngle(midnight - 1);
    const after = greenwichHourAngle(midnight + 1);
    const step = Math.abs(((after - before + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    // Two milliseconds of Earth rotation, generously bounded.
    expect(step).toBeLessThan(1e-6);
  });

  test("advances at Earth's rotation rate", () => {
    const t0 = Date.UTC(2026, 2, 3, 4, 5, 6);
    const perSecond = greenwichHourAngle(t0 + 1000) - greenwichHourAngle(t0);
    expect(perSecond).toBeCloseTo(7.2921158553e-5, 12);
  });

  test("keeps full resolution rather than losing it to a large julian float", () => {
    // The naive `2440587.5 + ms / 86400000` loses about 47 us of Earth rotation to
    // the ulp of a ~2.4e6 double, which measured as a 9.5 mm error. One millisecond
    // apart must therefore still be distinguishable, and by the right amount.
    const t0 = Date.UTC(2026, 8, 21, 18, 42, 11);
    const delta = greenwichHourAngle(t0 + 1) - greenwichHourAngle(t0);
    expect(delta).toBeGreaterThan(7.2e-8);
    expect(delta).toBeLessThan(7.4e-8);
  });

  test("matches Cesium at GEO radius, where the same angle error costs six times more", () => {
    const teme = new Cartesian3(GEO_RADIUS, 0, 0);
    expect(deviationMetres(Date.UTC(2027, 10, 2, 7, 13, 29), teme)).toBeLessThan(1e-5);
  });
});

describe("leap seconds", () => {
  // This module reads UTC epoch milliseconds directly; Cesium carries TAI and
  // subtracts taiMinusUtc. The two agree exactly while no leap second falls in
  // between, which has been the case since 2017 and is expected to remain so - the
  // IERS has resolved to stop inserting them. This test exists to pin what happens
  // if that changes rather than to assert it never will: the failure mode is a
  // one-second rotation offset, and it is worth knowing that it stays bounded to
  // that instead of corrupting the whole window.
  test("agrees on both sides of a historical leap second", () => {
    const teme = new Cartesian3(LEO_RADIUS, 0, 0);
    // 2016-12-31T23:59:60Z was the most recent insertion.
    const wellBefore = Date.UTC(2016, 11, 31, 12, 0, 0);
    const wellAfter = Date.UTC(2017, 0, 1, 12, 0, 0);
    expect(deviationMetres(wellBefore, teme)).toBeLessThan(1e-5);
    expect(deviationMetres(wellAfter, teme)).toBeLessThan(1e-5);
  });
});

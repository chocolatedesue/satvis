import { Cartesian3 } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { enuDirection, levelBasis, normalizeAzimuth, rollBasis, rollOf } from "./skyGeometry";

const angles = [
  [0, 0],
  [37, 15],
  [180, -30],
  [270, 60],
  [45, 89],
  [300, 90],
] as const;

describe("enuDirection", () => {
  test("names the cardinal directions", () => {
    expect(enuDirection(0, 0)).toMatchObject({ x: expect.closeTo(0, 12), y: expect.closeTo(1, 12), z: expect.closeTo(0, 12) });
    expect(enuDirection(90, 0)).toMatchObject({ x: expect.closeTo(1, 12), y: expect.closeTo(0, 12), z: expect.closeTo(0, 12) });
    expect(enuDirection(0, 90)).toMatchObject({ x: expect.closeTo(0, 12), y: expect.closeTo(0, 12), z: expect.closeTo(1, 12) });
  });

  test("scales by the distance without turning", () => {
    const unit = enuDirection(123, 45);
    const far = enuDirection(123, 45, 1000);
    expect(Cartesian3.magnitude(far)).toBeCloseTo(1000, 9);
    expect(Cartesian3.angleBetween(unit, far)).toBeCloseTo(0, 9);
  });
});

describe("levelBasis", () => {
  test("keeps the horizon level at every elevation", () => {
    for (const [azimuth, elevation] of angles) {
      expect(levelBasis(azimuth, elevation).right.z, `az=${azimuth} el=${elevation}`).toBeCloseTo(0, 12);
    }
  });

  test("is orthonormal against the direction it belongs to", () => {
    for (const [azimuth, elevation] of angles) {
      const direction = enuDirection(azimuth, elevation);
      const { up, right } = levelBasis(azimuth, elevation);
      const label = `az=${azimuth} el=${elevation}`;
      expect(Cartesian3.magnitude(up), label).toBeCloseTo(1, 12);
      expect(Cartesian3.magnitude(right), label).toBeCloseTo(1, 12);
      expect(Cartesian3.dot(direction, up), label).toBeCloseTo(0, 12);
      expect(Cartesian3.dot(direction, right), label).toBeCloseTo(0, 12);
      expect(Cartesian3.dot(up, right), label).toBeCloseTo(0, 12);
    }
  });
});

describe("rollBasis and rollOf", () => {
  // The regression this file exists for. Composing roll and decomposing it were
  // written in two modules from the same formula, and disagreed in sign: feeding
  // a device's measured roll back into the camera basis mirrored the view. They
  // are each other's inverse now, and this is what holds them there.
  test("are exact inverses", () => {
    for (const [azimuth, elevation] of angles) {
      for (const roll of [-170, -90, -30, 0, 30, 90, 170]) {
        const { up } = rollBasis(azimuth, elevation, roll);
        expect(rollOf(azimuth, elevation, up), `az=${azimuth} el=${elevation} roll=${roll}`).toBeCloseTo(roll, 9);
      }
    }
  });

  test("reports no roll for the level basis", () => {
    for (const [azimuth, elevation] of angles) {
      expect(rollOf(azimuth, elevation, levelBasis(azimuth, elevation).up), `az=${azimuth} el=${elevation}`).toBeCloseTo(0, 12);
    }
  });

  test("turns the basis about the view axis and nothing else", () => {
    const direction = enuDirection(120, 40);
    const rolled = rollBasis(120, 40, 30);
    expect(Cartesian3.dot(direction, rolled.up)).toBeCloseTo(0, 12);
    expect(Cartesian3.dot(direction, rolled.right)).toBeCloseTo(0, 12);
    expect(Cartesian3.dot(rolled.up, rolled.right)).toBeCloseTo(0, 12);
  });
});

describe("normalizeAzimuth", () => {
  test("wraps onto [0, 360)", () => {
    expect(normalizeAzimuth(0)).toBe(0);
    expect(normalizeAzimuth(360)).toBe(0);
    expect(normalizeAzimuth(-90)).toBe(270);
    expect(normalizeAzimuth(450)).toBe(90);
    expect(normalizeAzimuth(-720.5)).toBeCloseTo(359.5, 9);
  });
});

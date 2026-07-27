import { Cartesian3, Math as CesiumMath } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { type Aim, defaultAzimuth, fovFromFovy, isPlausibleGroundHeight, skyBasis } from "./SkyView";

const aim = (azimuth: number, pitch: number, roll = 0): Aim => ({ azimuth, pitch, roll });

const angleBetween = (a: Cartesian3, b: Cartesian3): number => CesiumMath.toDegrees(Cartesian3.angleBetween(a, b));

describe("skyBasis", () => {
  // Every case the camera has to survive, including the one `camera.setView`
  // cannot express: straight up, where its heading formula switches branch.
  const aims = [aim(0, 0), aim(90, 45), aim(180, -30), aim(270, 87.3), aim(0, 87.5), aim(45, 90), aim(300, 60, 35), aim(0, 90, 180)];

  test("is orthonormal and right-handed at every aim", () => {
    for (const a of aims) {
      const { direction, up, right } = skyBasis(a);
      const label = `az=${a.azimuth} pitch=${a.pitch} roll=${a.roll}`;

      expect(Cartesian3.magnitude(direction), label).toBeCloseTo(1, 12);
      expect(Cartesian3.magnitude(up), label).toBeCloseTo(1, 12);
      expect(Cartesian3.magnitude(right), label).toBeCloseTo(1, 12);

      expect(Cartesian3.dot(direction, up), label).toBeCloseTo(0, 12);
      expect(Cartesian3.dot(direction, right), label).toBeCloseTo(0, 12);
      expect(Cartesian3.dot(up, right), label).toBeCloseTo(0, 12);

      // right = direction x up, the handedness Cesium's camera assumes.
      const cross = Cartesian3.cross(direction, up, new Cartesian3());
      expect(angleBetween(cross, right), label).toBeCloseTo(0, 6);
    }
  });

  test("points where the azimuth and pitch say", () => {
    // East-north-up components, azimuth clockwise from north.
    expect(skyBasis(aim(0, 0)).direction).toMatchObject({ x: expect.closeTo(0, 12), y: expect.closeTo(1, 12), z: expect.closeTo(0, 12) });
    expect(skyBasis(aim(90, 0)).direction).toMatchObject({ x: expect.closeTo(1, 12), y: expect.closeTo(0, 12), z: expect.closeTo(0, 12) });
    expect(skyBasis(aim(0, 90)).direction).toMatchObject({ x: expect.closeTo(0, 12), y: expect.closeTo(0, 12), z: expect.closeTo(1, 12) });
    expect(skyBasis(aim(0, -90)).direction).toMatchObject({ x: expect.closeTo(0, 12), y: expect.closeTo(0, 12), z: expect.closeTo(-1, 12) });
  });

  test("keeps the horizon level when there is no roll", () => {
    // `right` has no vertical component, so the horizon is horizontal on screen.
    for (const pitch of [-90, -45, 0, 45, 87.5, 90]) {
      const { right } = skyBasis(aim(210, pitch));
      expect(right.z, `pitch=${pitch}`).toBeCloseTo(0, 12);
    }
  });

  test("rolls about the view axis without moving it", () => {
    const level = skyBasis(aim(120, 40));
    const rolled = skyBasis(aim(120, 40, 30));

    expect(angleBetween(level.direction, rolled.direction)).toBeCloseTo(0, 9);
    expect(angleBetween(level.up, rolled.up)).toBeCloseTo(30, 9);
    expect(angleBetween(level.right, rolled.right)).toBeCloseTo(30, 9);
  });

  // The failure this whole approach exists to avoid: `setView` derives the roll
  // from direction/up and switches formula within EPSILON3 of straight up, so it
  // reports 175° of roll error at 87.5° and 180° at 90° — the sky mirrors. A
  // basis built from the angles has no such branch, so a quarter-degree step
  // across the zenith moves it a quarter of a degree.
  test("is continuous through the zenith", () => {
    const step = 0.25;
    for (let pitch = 85; pitch < 90; pitch += step) {
      const before = skyBasis(aim(0, pitch));
      const after = skyBasis(aim(0, Math.min(pitch + step, 90)));
      const label = `pitch=${pitch}`;

      expect(angleBetween(before.direction, after.direction), label).toBeLessThan(step * 1.001);
      expect(angleBetween(before.up, after.up), label).toBeLessThan(step * 1.001);
      expect(angleBetween(before.right, after.right), label).toBeLessThan(step * 1.001);
    }
  });

  test("has no roll at the zenith itself", () => {
    // Facing north at the zenith, the top of the screen is due south — the
    // continuous limit of tipping the view up, not its mirror image.
    const { up } = skyBasis(aim(0, 90));
    expect(up.x).toBeCloseTo(0, 12);
    expect(up.y).toBeCloseTo(-1, 12);
    expect(up.z).toBeCloseTo(0, 12);
  });
});

describe("fovFromFovy", () => {
  // Cesium derives fovy back out as `aspect <= 1 ? fov : 2*atan(tan(fov/2)/aspect)`,
  // so this has to be its exact inverse or the vertical framing is not what was asked for.
  const cesiumFovy = (fov: number, aspectRatio: number): number => (aspectRatio <= 1 ? fov : 2 * Math.atan(Math.tan(fov * 0.5) / aspectRatio));

  test("round-trips through Cesium's own derivation", () => {
    for (const fovyDegrees of [45, 65, 75, 100]) {
      for (const aspectRatio of [0.46, 1, 16 / 9, 21 / 9]) {
        const fovy = CesiumMath.toRadians(fovyDegrees);
        expect(cesiumFovy(fovFromFovy(fovy, aspectRatio), aspectRatio)).toBeCloseTo(fovy, 12);
      }
    }
  });

  test("is the identity on a portrait viewport, where Cesium's fov is already vertical", () => {
    const fovy = CesiumMath.toRadians(75);
    expect(fovFromFovy(fovy, 0.46)).toBe(fovy);
    expect(fovFromFovy(fovy, 1)).toBe(fovy);
  });

  test("survives a viewport with no height yet", () => {
    const fovy = CesiumMath.toRadians(75);
    expect(fovFromFovy(fovy, Number.NaN)).toBe(fovy);
  });
});

describe("isPlausibleGroundHeight", () => {
  test("accepts real ground", () => {
    expect(isPlausibleGroundHeight(0)).toBe(true);
    expect(isPlausibleGroundHeight(519)).toBe(true);
    expect(isPlausibleGroundHeight(-430)).toBe(true);
    expect(isPlausibleGroundHeight(8849)).toBe(true);
  });

  test("rejects a missing tile reporting itself as a number", () => {
    // Observed from `globe.getHeight` at 48.14N 11.58E under the default
    // EllipsoidTerrainProvider, where the true answer is 0. Believing it put the
    // camera 37 km down, which stopped the tiles under the observer rendering,
    // which kept the answer wrong.
    expect(isPlausibleGroundHeight(-36990.17462565757)).toBe(false);
  });

  test("rejects absent and non-finite answers", () => {
    expect(isPlausibleGroundHeight(undefined)).toBe(false);
    expect(isPlausibleGroundHeight(Number.NaN)).toBe(false);
    expect(isPlausibleGroundHeight(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("defaultAzimuth", () => {
  test("faces the equator, where the passes are", () => {
    expect(defaultAzimuth({ lat: 48.14, lon: 11.58 })).toBe(180);
    expect(defaultAzimuth({ lat: 0, lon: 0 })).toBe(180);
    expect(defaultAzimuth({ lat: -33.9, lon: 151.2 })).toBe(0);
  });
});

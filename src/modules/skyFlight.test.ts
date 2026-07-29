import { Cartesian3, Math as CesiumMath, Quaternion } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { easeFlight, type FlightPath, flightPose, flightPosition, LOCK_ON, newPose, type Pose, poseRotation, TIP_UP, TOUCHDOWN } from "./skyFlight";

const EARTH_RADIUS = 6378137;

const at = (x: number, y: number, z: number, radius: number): Cartesian3 =>
  Cartesian3.multiplyByScalar(Cartesian3.normalize(new Cartesian3(x, y, z), new Cartesian3()), radius, new Cartesian3());

const pose = (position: Cartesian3, direction: Cartesian3, up: Cartesian3, fovy = 60): Pose => {
  const d = Cartesian3.normalize(direction, new Cartesian3());
  const u = Cartesian3.normalize(up, new Cartesian3());
  return { position, direction: d, up: u, right: Cartesian3.cross(d, u, new Cartesian3()), fovy };
};

const angleDegrees = (a: Cartesian3, b: Cartesian3): number => CesiumMath.toDegrees(Cartesian3.angleBetween(a, b));

/** How far one attitude has to turn to become another, the short way round. */
function turnBetween(a: Pose, b: Pose): number {
  const from = poseRotation(a, new Quaternion());
  const to = poseRotation(b, new Quaternion());
  const delta = Quaternion.multiply(to, Quaternion.conjugate(from, new Quaternion()), new Quaternion());
  return CesiumMath.toDegrees(2 * Math.acos(Math.min(1, Math.abs(delta.w))));
}

/** A camera in orbit over the Gulf of Guinea, looking straight down with north up. */
const orbit = pose(at(1, 0, 0, EARTH_RADIUS + 20_000_000), new Cartesian3(-1, 0, 0), new Cartesian3(0, 0, 1), 36);

// The destination is on the equator a quarter turn east, where the local east,
// north and up axes are these. Written out because every attitude below is one
// of them or a combination, and the tests are unreadable in raw components.
const destination = at(0, 1, 0, EARTH_RADIUS + 2);
const EAST = new Cartesian3(-1, 0, 0);
const NORTH = new Cartesian3(0, 0, 1);
const UP = new Cartesian3(0, 1, 0);

/** Standing there, facing north, 45° above the horizon — the aim the flight ends on. */
const ground = pose(destination, new Cartesian3(0, 1, 1), new Cartesian3(0, 1, -1), 75);

/**
 * The same spot and the same facing, tipped all the way down.
 *
 * `up` is north because that is the continuous limit of tipping the aim above
 * down toward the horizon — the relationship `skyBasis` gives between a -90° aim
 * and every aim above it, and what makes the last leg a pure change of pitch.
 */
const overGround = pose(destination, Cartesian3.negate(UP, new Cartesian3()), NORTH);

const path: FlightPath = { from: orbit, to: ground, over: overGround };

describe("flightPosition", () => {
  const between = (from: Cartesian3, to: Cartesian3, sweep: number, drop = sweep): Cartesian3 => flightPosition(from, to, sweep, drop, new Cartesian3());

  test("starts and ends exactly where it was told to", () => {
    expect(Cartesian3.distance(between(orbit.position, destination, 0), orbit.position)).toBeLessThan(1e-6);
    expect(Cartesian3.distance(between(orbit.position, destination, 1), destination)).toBeLessThan(1e-6);
  });

  test("follows the great circle rather than the chord", () => {
    const total = angleDegrees(orbit.position, destination);
    for (const t of [0.25, 0.5, 0.75]) {
      expect(angleDegrees(orbit.position, between(orbit.position, destination, t))).toBeCloseTo(total * t, 6);
    }
  });

  test("comes down where it is told to, independently of how far round it has come", () => {
    // The two fractions are what let the flight stop over the destination and
    // then land on it, so neither may leak into the other.
    const overhead = between(orbit.position, destination, 1, 0.4);
    expect(angleDegrees(overhead, destination)).toBeCloseTo(0, 9);
    const radii = [Cartesian3.magnitude(orbit.position), Cartesian3.magnitude(destination)];
    expect(Cartesian3.magnitude(overhead)).toBeCloseTo(radii[0]! + 0.4 * (radii[1]! - radii[0]!), 6);
  });

  test("never dips below either end, so no arc height is needed to clear the ground", () => {
    // The distance from the geocentre is interpolated on its own, so it stays
    // inside the interval the two endpoints bound — and both are above ground.
    const low = Math.min(Cartesian3.magnitude(orbit.position), Cartesian3.magnitude(destination));
    for (let t = 0; t <= 1; t += 0.02) {
      expect(Cartesian3.magnitude(between(orbit.position, destination, Math.min(1, t * 1.4), t))).toBeGreaterThanOrEqual(low - 1e-6);
    }
  });

  test("crosses the planet from the antipode without going through it", () => {
    // The one input with no unique great circle: the cross product vanishes, and
    // taking it as the rotation axis would give a zero-length axis and NaN.
    const from = at(1, 0, 0, EARTH_RADIUS + 1_000_000);
    const to = at(-1, 0, 0, EARTH_RADIUS + 2);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const step = between(from, to, t);
      expect(Number.isFinite(step.x) && Number.isFinite(step.y) && Number.isFinite(step.z)).toBe(true);
      expect(angleDegrees(from, step)).toBeCloseTo(180 * t, 6);
    }
  });

  test("stays put when both ends are the same place", () => {
    const here = at(0.3, -0.9, 0.2, EARTH_RADIUS + 2);
    expect(Cartesian3.distance(between(here, here, 0.5), here)).toBeLessThan(1e-6);
  });
});

describe("flightPose", () => {
  const step = (t: number): Pose => flightPose(path, t, newPose());

  /** How far off the centre of the screen the destination sits, in degrees. */
  const offCentre = (here: Pose): number => angleDegrees(here.direction, Cartesian3.subtract(destination, here.position, new Cartesian3()));

  test("starts and ends on the poses it was given", () => {
    for (const [t, end] of [
      [0, orbit],
      [1, ground],
    ] as const) {
      const here = step(t);
      expect(Cartesian3.distance(here.position, end.position)).toBeLessThan(1e-6);
      expect(angleDegrees(here.direction, end.direction)).toBeCloseTo(0, 6);
      expect(angleDegrees(here.up, end.up)).toBeCloseTo(0, 6);
      expect(angleDegrees(here.right, end.right)).toBeCloseTo(0, 6);
      expect(here.fovy).toBeCloseTo(end.fovy, 9);
    }
  });

  test("holds the destination at the centre of the screen for the whole descent", () => {
    // The point of the three legs. Between the swing finishing and the rise
    // starting, the place being flown to is the thing on screen — which is the
    // only way the flight can say where it is going while it is still going.
    for (let t = LOCK_ON; t <= 1 - TIP_UP; t += 0.02) {
      expect(offCentre(step(t)), `t=${t.toFixed(2)}`).toBeLessThan(1e-4);
    }
  });

  test("brings the destination in without overshooting it", () => {
    // Monotone through the swing: the view converges on the destination rather
    // than sweeping past it and coming back. It starts well off centre — only
    // 13° here, because a quarter of the globe away subtends little from 20,000
    // km up, and that is exactly the confusion the swing exists to clear up.
    let previous = offCentre(step(0));
    expect(previous).toBeGreaterThan(10);
    for (let t = 0.01; t <= LOCK_ON; t += 0.01) {
      const off = offCentre(step(t));
      // To within a tenth of a degree: the destination is a moving target while
      // the camera is travelling, so the swing trails it by a hair as it closes.
      expect(off, `t=${t.toFixed(2)}`).toBeLessThanOrEqual(previous + 0.1);
      previous = Math.min(previous, off);
    }
    expect(previous).toBeLessThan(0.1);
  });

  test("comes to rest directly over the destination as the rise begins", () => {
    // Arriving vertically rather than along the swoop's own tangent. Without it
    // the camera reaches the ground travelling sideways and the aim following it
    // whips through the last few metres.
    const overhead = step(1 - TIP_UP);
    expect(angleDegrees(overhead.position, destination)).toBeCloseTo(0, 9);
    expect(Cartesian3.magnitude(overhead.position)).toBeGreaterThan(Cartesian3.magnitude(destination));
  });

  test("is standing on the destination before the rise finishes", () => {
    // Land, then look up — two movements rather than one blurred diagonal.
    expect(Cartesian3.distance(step(TOUCHDOWN).position, destination)).toBeLessThan(1e-6);
    expect(angleDegrees(step(TOUCHDOWN).direction, ground.direction)).toBeGreaterThan(30);
  });

  test("rises through the horizon rather than around it", () => {
    // The last leg is a change of pitch and nothing else, so the view axis stays
    // in the vertical plane it spent the descent facing: no drift in azimuth, and
    // no roll. East is the normal of that plane for this destination.
    for (let t = 1 - TIP_UP; t <= 1; t += 0.02) {
      const here = step(t);
      expect(Cartesian3.dot(here.direction, EAST), `t=${t.toFixed(2)}`).toBeCloseTo(0, 6);
      expect(Cartesian3.dot(here.up, EAST), `t=${t.toFixed(2)}`).toBeCloseTo(0, 6);
    }
  });

  test("hands the camera an orthonormal right-handed basis at every step", () => {
    // The whole reason the blend goes through a quaternion. Three separately
    // interpolated vectors are not orthonormal in between, and Cesium's camera
    // takes what it is given: a sheared basis is a sheared picture.
    for (let t = 0; t <= 1; t += 0.02) {
      const { direction, up, right } = step(t);
      const label = `t=${t.toFixed(2)}`;

      expect(Cartesian3.magnitude(direction), label).toBeCloseTo(1, 9);
      expect(Cartesian3.magnitude(up), label).toBeCloseTo(1, 9);
      expect(Cartesian3.magnitude(right), label).toBeCloseTo(1, 9);
      expect(Cartesian3.dot(direction, up), label).toBeCloseTo(0, 9);
      expect(Cartesian3.dot(direction, right), label).toBeCloseTo(0, 9);
      expect(Cartesian3.dot(up, right), label).toBeCloseTo(0, 9);

      const cross = Cartesian3.cross(direction, up, new Cartesian3());
      expect(angleDegrees(cross, right), label).toBeCloseTo(0, 6);
    }
  });

  test("takes the short way round rather than spinning to the same attitude", () => {
    // `Quaternion.slerp` negates one end when the two point away from each other.
    // Without that the blend arrives at the right attitude by turning most of a
    // revolution to get there — which a smoothness check cannot catch, because a
    // long way round is perfectly smooth. Adding up how far the view actually
    // turns can: a spin would cost another 180° at least.
    let travelled = 0;
    let previous = step(0);
    for (let t = 0.005; t <= 1; t += 0.005) {
      const next = step(t);
      travelled += turnBetween(previous, next);
      previous = next;
    }
    // 90° from the globe attitude to straight down at the destination, then 135°
    // of rise, plus the slack the descent's own tracking adds on top.
    expect(travelled).toBeLessThan(turnBetween(orbit, overGround) + turnBetween(overGround, ground) + 45);
  });

  test("moves smoothly, with no jump at either join between legs", () => {
    const dt = 0.002;
    let previous = step(0);
    for (let t = dt; t <= 1; t += dt) {
      const next = step(t);
      const label = `t=${t.toFixed(3)}`;
      // Three degrees per two thousandths is roughly triple the fastest the view
      // legitimately turns — which is mid-descent, where the camera really is
      // racing a quarter of the way round the planet with the destination pinned.
      // A join that failed to meet would show up here as tens of degrees.
      expect(angleDegrees(previous.direction, next.direction), label).toBeLessThan(3);
      expect(angleDegrees(previous.up, next.up), label).toBeLessThan(3);
      previous = next;
    }
  });

  test("widens the field of view on the way in, and has finished by the landing", () => {
    expect(step(0.4).fovy).toBeGreaterThan(orbit.fovy);
    expect(step(0.4).fovy).toBeLessThan(ground.fovy);
    // Steady through the rise: a zoom laid over the sweep would read as a second,
    // unrelated movement.
    expect(step(TOUCHDOWN).fovy).toBeCloseTo(ground.fovy, 9);
  });

  test("stays defined once the camera is standing on the point it is aiming at", () => {
    // Past touchdown there is no line of sight left to aim along — a look-at
    // built from a cross product would be dividing by zero here every frame.
    for (let t = TOUCHDOWN; t <= 1; t += 0.01) {
      const { direction, up, right } = step(t);
      const finite = (v: Cartesian3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      expect(finite(direction) && finite(up) && finite(right), `t=${t.toFixed(2)}`).toBe(true);
    }
  });
});

describe("poseRotation", () => {
  test("is a unit rotation, which is what the blend and the conversion back need", () => {
    for (const p of [orbit, ground, overGround]) {
      expect(Quaternion.magnitude(poseRotation(p, new Quaternion()))).toBeCloseTo(1, 9);
    }
  });
});

describe("easeFlight", () => {
  test("pins both ends, so the flight lands exactly on its destination", () => {
    expect(easeFlight(0)).toBe(0);
    expect(easeFlight(1)).toBe(1);
  });

  test("clamps, because that is also how each leg is scheduled off the shared clock", () => {
    expect(easeFlight(-0.5)).toBe(0);
    expect(easeFlight(1.7)).toBe(1);
  });

  test("never goes backwards", () => {
    let previous = 0;
    for (let t = 0; t <= 1; t += 0.01) {
      const eased = easeFlight(t);
      expect(eased).toBeGreaterThanOrEqual(previous);
      previous = eased;
    }
  });
});

import { Cartesian3, JulianDate, Matrix3, Transforms } from "@cesium/engine";
import dayjs from "dayjs";
import { beforeEach, describe, expect, test, vi } from "vitest";

import Orbit from "./Orbit";
import { SampledTrajectory } from "./SampledTrajectory";
import { parseGpPayload, type GpRecord } from "./util/gp";

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

// Time near the TLE epoch so SGP4 propagation stays meaningful.
const T0 = JulianDate.fromDate(dayjs("2018-12-08").toDate());

function issTrajectory(): { orbit: Orbit; trajectory: SampledTrajectory; periodSeconds: number } {
  const orbit = new Orbit("ISS", parseGpPayload(TLE)[0] as GpRecord);
  return { orbit, trajectory: new SampledTrajectory(orbit), periodSeconds: orbit.orbitalPeriod * 60 };
}

beforeEach(() => {
  // The ICRF transform needs async-loaded IAU data that is unavailable in
  // Node; pin it to identity — these tests cover the window bookkeeping, not
  // the frame conversion itself.
  vi.spyOn(Transforms, "computeFixedToIcrfMatrix").mockImplementation(() => Matrix3.clone(Matrix3.IDENTITY));
});

describe("SampledTrajectory", () => {
  test("is empty before the first update", () => {
    const { trajectory } = issTrajectory();
    expect(trajectory.valid).toBe(false);
    expect(trajectory.fixed).toBeUndefined();
    expect(trajectory.interval).toBeUndefined();
    expect(trajectory.position(T0)).toBeUndefined();
    expect(trajectory.positionsForNextOrbit(T0)).toHaveLength(0);
  });

  test("update covers half an orbit back and 1.5 orbits forward", () => {
    const { trajectory, periodSeconds } = issTrajectory();
    trajectory.update(T0);

    expect(trajectory.valid).toBe(true);
    const interval = trajectory.interval!;
    expect(JulianDate.secondsDifference(T0, interval.start)).toBeCloseTo(periodSeconds / 2, 5);
    expect(JulianDate.secondsDifference(interval.stop, T0)).toBeCloseTo(periodSeconds * 1.5, 5);

    // Interpolated fixed-frame position sits at a plausible LEO radius.
    const position = trajectory.position(T0);
    expect(position).toBeDefined();
    expect(Cartesian3.magnitude(position!) / 1000).toBeGreaterThan(6600);
    expect(Cartesian3.magnitude(position!) / 1000).toBeLessThan(6900);
  });

  test("window slides forward as time advances", () => {
    const { trajectory, periodSeconds } = issTrajectory();
    trajectory.update(T0);

    const later = JulianDate.addSeconds(T0, periodSeconds, new JulianDate());
    trajectory.update(later);

    const interval = trajectory.interval!;
    expect(JulianDate.secondsDifference(later, interval.start)).toBeCloseTo(periodSeconds / 2, 5);
    expect(JulianDate.secondsDifference(interval.stop, later)).toBeCloseTo(periodSeconds * 1.5, 5);
    expect(trajectory.position(later)).toBeDefined();
  });

  test("positionsForNextOrbit returns one orbit of raw samples closed into a loop", () => {
    const { trajectory } = issTrajectory();
    trajectory.update(T0);

    const positions = trajectory.positionsForNextOrbit(T0);
    // ~120 samples per orbit plus the repeated first sample closing the loop.
    expect(positions.length).toBeGreaterThan(100);
    expect(positions.at(-1)).toBe(positions[0]);

    const open = trajectory.positionsForNextOrbit(T0, "inertial", false);
    expect(open.length).toBe(positions.length - 1);
  });

  test("groundTrack samples positions around the given time", () => {
    const { trajectory } = issTrajectory();
    trajectory.update(T0);

    const track = trajectory.groundTrack(T0, 2, 1);
    expect(track).toHaveLength(4);
    expect(track.every((position) => position !== undefined)).toBe(true);
  });
});

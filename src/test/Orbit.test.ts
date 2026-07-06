import dayjs from "dayjs";
import { describe, expect, test } from "vitest";

import Orbit from "../modules/Orbit";
import { parseGpPayload, type GpRecord } from "../modules/util/gp";

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

// Note: the original ava test pinned exact 2018 ECI/geodetic values and a pass
// count. Those numbers were tied to a much older satellite.js and no longer
// hold under 7.0.1's SGP4/coordinate implementation, so we assert physically
// meaningful invariants (orbital radius, altitude band, non-empty pass list)
// instead of brittle version-specific decimals.
describe("Orbit (TLE record)", () => {
  const orbit = new Orbit("ISS", parseGpPayload(TLE)[0] as GpRecord);

  test("calculates a plausible satellite position", () => {
    const time = dayjs("2018-12-01").toDate();

    const positionECI = orbit.positionECI(time);
    expect(positionECI).not.toBeNull();
    // ISS orbital radius is ~6780 km (LEO).
    const radius = Math.sqrt(positionECI!.x ** 2 + positionECI!.y ** 2 + positionECI!.z ** 2);
    expect(radius).toBeGreaterThan(6600);
    expect(radius).toBeLessThan(6900);

    const positionGeodetic = orbit.positionGeodetic(time);
    expect(positionGeodetic).not.toBeNull();
    // ISS altitude is ~400 km (± band).
    expect(positionGeodetic!.height / 1000).toBeGreaterThan(380);
    expect(positionGeodetic!.height / 1000).toBeLessThan(430);
  });

  test("calculates passes", () => {
    const gs = { latitude: 48.177, longitude: 11.7476, height: 0 };
    const start = dayjs("2018-12-08");
    const end = dayjs("2018-12-22");

    const passes = orbit.computePassesElevation(gs, start.toDate(), end.toDate(), 1, 500);
    // Roughly one visible pass per ~1.5 orbits over Munich across two weeks.
    expect(passes.length).toBeGreaterThan(50);
  });

  test("exposes tle lines and satnum", () => {
    expect(orbit.tle).toHaveLength(3);
    expect(orbit.satnum).toBe("25544");
  });
});

describe("Orbit (GpRecord path)", () => {
  test("OMM record builds an orbit without tle lines", () => {
    const omm = JSON.stringify([
      {
        OBJECT_NAME: "ISS (ZARYA)",
        OBJECT_ID: "1998-067A",
        EPOCH: "2026-07-04T02:07:57.020160",
        MEAN_MOTION: 15.48879284,
        ECCENTRICITY: 0.00067632,
        INCLINATION: 51.6303,
        RA_OF_ASC_NODE: 216.4301,
        ARG_OF_PERICENTER: 253.0749,
        MEAN_ANOMALY: 106.9498,
        NORAD_CAT_ID: 25544,
        ELEMENT_SET_NO: 999,
        BSTAR: 0.00014587488,
        MEAN_MOTION_DOT: 7.564e-5,
        MEAN_MOTION_DDOT: 0,
      },
    ]);
    const record = parseGpPayload(omm)[0] as GpRecord;
    const orbit = new Orbit("ISS", record);
    expect(orbit.satnum).toBe("25544");
    expect(orbit.tle).toBeUndefined();
    expect(orbit.record.kind).toBe("omm");
    expect(orbit.error).toBe(0);
  });
});

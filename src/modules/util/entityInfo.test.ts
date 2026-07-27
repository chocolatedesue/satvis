import { describe, expect, test } from "vitest";

import Orbit from "../Orbit";
import { formatEpoch, getSatelliteInfo } from "./entityInfo";
import { parseGpPayload, type GpRecord } from "./gp";

const ISS_TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

function issOrbit(): Orbit {
  return new Orbit("ISS", parseGpPayload(ISS_TLE)[0] as GpRecord);
}

function labels(rows: [string, string][]): string[] {
  return rows.map(([label]) => label);
}

function valueOf(rows: [string, string][], label: string): string | undefined {
  return rows.find(([rowLabel]) => rowLabel === label)?.[1];
}

describe("formatEpoch", () => {
  test("formats a julian date as UTC timestamp", () => {
    // JD 2460000.5 == 2023-02-25T00:00:00Z
    expect(formatEpoch(2460000.5)).toBe("2023-02-25 00:00:00");
  });
});

describe("getSatelliteInfo", () => {
  test("always reports the derived orbit class, even with no metadata", () => {
    expect(getSatelliteInfo(issOrbit(), {})).toEqual([["Orbit", "LEO"]]);
  });

  test("omits every row the record does not carry, rather than showing defaults", () => {
    // A satellite absent from the satellite table still renders with a 200 km
    // swath and a 10° cone; showing those here would present a renderer fallback
    // as a fact about the satellite.
    expect(labels(getSatelliteInfo(issOrbit(), {}))).not.toContain("Swath");
    expect(labels(getSatelliteInfo(issOrbit(), {}))).not.toContain("Sensor FOV");
  });

  test("shows a symmetric swath as a single total", () => {
    const rows = getSatelliteInfo(issOrbit(), { swathStarboardKm: 1175, swathPortKm: 1175 });
    expect(valueOf(rows, "Swath")).toBe("2350 km");
  });

  test("spells out the sides when they differ", () => {
    const rows = getSatelliteInfo(issOrbit(), { swathStarboardKm: 1000, swathPortKm: 500 });
    expect(valueOf(rows, "Swath")).toBe("1500 km (1000 stbd / 500 port)");
  });

  test("includes the display-only fields when present", () => {
    const rows = getSatelliteInfo(issOrbit(), { coneFovDeg: 45, operator: "ESA", missionType: "Earth observation" });
    expect(valueOf(rows, "Sensor FOV")).toBe("45°");
    expect(valueOf(rows, "Operator")).toBe("ESA");
    expect(valueOf(rows, "Mission")).toBe("Earth observation");
  });
});

describe("Orbit.orbitClass", () => {
  // Mean motion (rev/day) is what the classification derives from; these element
  // sets differ only in that field and eccentricity.
  function orbitWithElements(meanMotion: number, eccentricity = 0.0001): Orbit {
    const omm = JSON.stringify([
      {
        OBJECT_NAME: "TEST",
        OBJECT_ID: "2020-001A",
        EPOCH: "2026-07-04T00:00:00.000000",
        MEAN_MOTION: meanMotion,
        ECCENTRICITY: eccentricity,
        INCLINATION: 51,
        RA_OF_ASC_NODE: 0,
        ARG_OF_PERICENTER: 0,
        MEAN_ANOMALY: 0,
        NORAD_CAT_ID: 1,
        ELEMENT_SET_NO: 999,
        BSTAR: 0,
        MEAN_MOTION_DOT: 0,
        MEAN_MOTION_DDOT: 0,
      },
    ]);
    return new Orbit("TEST", parseGpPayload(omm)[0] as GpRecord);
  }

  test("classifies the regimes from mean motion", () => {
    expect(orbitWithElements(15.5).orbitClass).toBe("LEO"); // ISS-like, ~93 min
    expect(orbitWithElements(2.0).orbitClass).toBe("MEO"); // GPS-like, ~720 min
    expect(orbitWithElements(1.0027).orbitClass).toBe("GEO"); // geosynchronous, ~1436 min
  });

  test("eccentricity wins over period — a Molniya orbit is HEO, not MEO", () => {
    // ~12 h period like a MEO satellite, but e=0.72 puts it nowhere near one.
    expect(orbitWithElements(2.0, 0.72).orbitClass).toBe("HEO");
  });

  test("covers every satellite, not only those in the satellite table", () => {
    // The point of deriving rather than configuring: an arbitrary record classifies.
    expect(issOrbit().orbitClass).toBe("LEO");
  });
});

// What holds the orbit model together.
//
// The abstraction this file guards is a *de-duplication*, so the tests here are
// equivalences rather than behaviours: they assert that the one implementation
// each formula now has is the one the modules that used to restate it still
// report. If someone re-inlines a rate somewhere, the drift shows up here rather
// than as two panels disagreeing by a tenth of a degree.
//
// Two of them are therefore deliberately cheap (`shellRates === orbitalRates`).
// A test that only says "the alias is still the alias" is worth having precisely
// because the alias once was a second copy of the formula.

import { describe, expect, it } from "vitest";

import Orbit from "../Orbit";
import { clusterRadiusM, clusterSize, type ClusterFormationParams } from "./clusterFormation";
import { meanMotionRadPerSec } from "./formationSnapshot";
import { createSatrec } from "./gp";
import {
  circularMeanMotionRevPerDay,
  circularPeriodMinutes,
  circularSemiMajorAxisKm,
  orbitalRates,
  propagatedPeriodMinutes,
  raanOffsetError,
  wrapDegrees360,
  WGS72_EARTH_RADIUS_KM,
  WGS72_J2,
  WGS72_MU_KM3_S2,
} from "./orbitModel";
import { shellRates } from "./shellLayout";
import { nodalPrecessionDegPerDay, SUN_DEG_PER_DAY, sunSyncInclinationDeg } from "./sunSynchronous";
import { meanMotionRevPerDay, walkerDeltaRecords, type WalkerDeltaParams } from "./walkerDelta";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** A circular 550 km / 53° orbit, as the generators would state it. */
const STARLINK: WalkerDeltaParams = { total: 6, planes: 3, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };

const SUNCATCHER: ClusterFormationParams = { inclinationDeg: 97.99, altitudeKm: 650, pitchM: 100, rings: 5 };

function satrecOf(params: WalkerDeltaParams) {
  return createSatrec(walkerDeltaRecords(params, EPOCH)[0]!);
}

describe("WGS-72 constants", () => {
  // The values SGP4 itself works in. Five modules each carried their own copy;
  // a change to one here is a change to every one of them, and this is the test
  // that says the number did not move while it was being moved.
  it("are the WGS-72 / SGP4 values", () => {
    expect(WGS72_EARTH_RADIUS_KM).toBe(6378.135);
    expect(WGS72_MU_KM3_S2).toBe(398600.8);
    expect(WGS72_J2).toBe(0.001082616);
  });

  it("put a 550 km orbit's semi-major axis where the generators do", () => {
    expect(circularSemiMajorAxisKm(550)).toBe(6928.135);
  });
});

describe("circularMeanMotionRevPerDay", () => {
  it("is the value the Walker generator has always stated", () => {
    for (const altitudeKm of [150, 400, 550, 780, 1200, 2000]) {
      expect(circularMeanMotionRevPerDay(altitudeKm)).toBe(meanMotionRevPerDay(altitudeKm));
    }
  });

  it("lands on the published revolutions a day for a 550 km shell", () => {
    // 15.05 rev/day is the number a 550 km Starlink shell is quoted at.
    expect(circularMeanMotionRevPerDay(550)).toBeCloseTo(15.0549, 3);
  });

  it("falls with altitude", () => {
    expect(circularMeanMotionRevPerDay(1200)).toBeLessThan(circularMeanMotionRevPerDay(550));
  });
});

describe("propagatedPeriodMinutes", () => {
  it("is what Orbit.orbitalPeriod reports", () => {
    const record = walkerDeltaRecords(STARLINK, EPOCH)[0]!;
    const orbit = new Orbit("W", record);
    expect(propagatedPeriodMinutes(orbit.satrec)).toBe(orbit.orbitalPeriod);
  });

  it("is about a second off the two-body period for the same altitude", () => {
    // The whole reason the two entries exist separately: SGP4 recovers a
    // semi-major axis from a Kozai mean motion with J2 in it, so the orbit it
    // flies is not quite the orbit that was asked for.
    const propagated = propagatedPeriodMinutes(satrecOf(STARLINK));
    expect(propagated).not.toBe(circularPeriodMinutes(STARLINK));
    expect(Math.abs(propagated - circularPeriodMinutes(STARLINK))).toBeLessThan(0.2);
  });

  it("stays unguarded, so a refused element set reports no period rather than zero", () => {
    const satrec = satrecOf(STARLINK);
    satrec.no = 0;
    expect(propagatedPeriodMinutes(satrec)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("orbitalRates", () => {
  it("is what shellLayout reports as a shell's rates", () => {
    // The alias, not a restatement: `shellRates` used to carry its own copy of
    // the mean motion and both secular rates.
    expect(shellRates).toBe(orbitalRates);
  });

  it("agrees with the node rate sunSynchronous inverts", () => {
    const rates = orbitalRates(STARLINK);
    expect(rates.nodeRateDegPerDay).toBeCloseTo(nodalPrecessionDegPerDay(STARLINK), 12);
  });

  it("puts a sun-synchronous orbit's node rate on the sun's", () => {
    const altitudeKm = 550;
    const inclinationDeg = sunSyncInclinationDeg(altitudeKm)!;
    expect(orbitalRates({ altitudeKm, inclinationDeg }).nodeRateDegPerDay).toBeCloseTo(SUN_DEG_PER_DAY, 9);
  });

  it("runs the along-track rate slightly off the Keplerian one, as J2 requires", () => {
    const rates = orbitalRates(STARLINK);
    const keplerian = rates.meanMotionRevPerDay * 360;
    expect(rates.alongTrackRateDegPerDay).not.toBe(keplerian);
    expect(rates.alongTrackRateDegPerDay / keplerian - 1).toBeLessThan(0.01);
  });

  it("gives a prograde orbit a negative node rate and a retrograde one a positive", () => {
    expect(orbitalRates({ altitudeKm: 550, inclinationDeg: 53 }).nodeRateDegPerDay).toBeLessThan(0);
    expect(orbitalRates({ altitudeKm: 550, inclinationDeg: 97.6 }).nodeRateDegPerDay).toBeGreaterThan(0);
  });
});

describe("meanMotionRadPerSec", () => {
  it("is the same two-body mean motion the formation's records state", () => {
    // formationSnapshot used to carry its own copy of μ/a³.
    const expected = (circularMeanMotionRevPerDay(SUNCATCHER.altitudeKm) * 2 * Math.PI) / 86400;
    expect(meanMotionRadPerSec(SUNCATCHER)).toBeCloseTo(expected, 15);
  });

  it("gives Suncatcher's cluster the period it is published at", () => {
    // 81 satellites, 650 km, 100 m × 200 m lattice — arXiv 2511.19468 §2.2.
    expect(clusterSize(SUNCATCHER.rings)).toBe(81);
    expect(clusterRadiusM(SUNCATCHER)).toBe(1000);
    expect((2 * Math.PI) / meanMotionRadPerSec(SUNCATCHER)).toBeCloseTo(5863.7, 0);
  });
});

describe("raanOffsetError", () => {
  it("accepts the range right ascension lives in, and nothing outside it", () => {
    expect(raanOffsetError(undefined)).toBeUndefined();
    expect(raanOffsetError(0)).toBeUndefined();
    expect(raanOffsetError(359.999)).toBeUndefined();
    expect(raanOffsetError(-1)).toBeDefined();
    expect(raanOffsetError(360)).toBeDefined();
    expect(raanOffsetError(Number.NaN)).toBeDefined();
  });

  it("carries the one sentence both generators used to restate", () => {
    expect(raanOffsetError(360)).toBe("RAAN offset must be at least 0° and below 360°.");
  });
});

describe("wrapDegrees360", () => {
  it("normalizes into [0, 360)", () => {
    expect(wrapDegrees360(0)).toBe(0);
    expect(wrapDegrees360(359.5)).toBe(359.5);
    expect(wrapDegrees360(360)).toBe(0);
    expect(wrapDegrees360(-1)).toBe(359);
    expect(wrapDegrees360(-721)).toBe(359);
  });
});

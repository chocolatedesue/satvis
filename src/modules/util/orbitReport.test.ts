// The numbers the README quotes, as data.
//
// `orbitReport` exists so that a script, a panel and a test read one set of
// answers. This file pins the ones published in `README.md`'s multi-shell section
// and in `docs/adr/0009`, so a change to the model has to change the prose too
// rather than quietly leaving it describing a design that no longer comes out.

import { describe, expect, it } from "vitest";

import { orbitReport } from "./orbitReport";

const STARLINK = { altitudeKm: 550, inclinationDeg: 53 };

describe("orbitReport", () => {
  it("reports a 53° / 550 km shell the way the README describes it", () => {
    const report = orbitReport(STARLINK);
    expect(report.rates.periodMinutes).toBeCloseTo(95.65, 1);
    expect(report.rates.nodeRateDegPerDay).toBeCloseTo(-4.49, 1);
    // The 1632 km co-precession ceiling, and the 8 satellites a ring needs.
    expect(report.coPrecessingCeilingKm).toBeCloseTo(1632, 0);
    expect(report.minSatellitesPerRing).toBe(8);
  });

  it("gives the sun's elevation budget the shadow demands", () => {
    const report = orbitReport(STARLINK);
    // A 550 km orbit needs |β| ≥ 67°; no 53° plane reaches more than 76.4°.
    expect(report.requiredBetaDeg).toBeCloseTo(67.02, 1);
    expect(report.reachableBetaDeg).toBeCloseTo(76.44, 1);
    expect(report.reachableBetaDeg).toBeGreaterThan(report.requiredBetaDeg);
    // …which is why only a sliver of node phases ever clears the shadow.
    expect(report.eclipseFreePlaneFraction).toBeGreaterThan(0);
    expect(report.eclipseFreePlaneFraction).toBeLessThan(0.1);
  });

  it("names the sun-synchronous inclination for the altitude, not for the orbit given", () => {
    // The inclination that would make *this altitude* sun-synchronous — a
    // property of the altitude, so it is reported even for a 53° orbit.
    expect(orbitReport(STARLINK).sunSyncInclinationDeg).toBeCloseTo(97.59, 1);
  });

  it("never brings a sun-synchronous orbit back round to the sun", () => {
    const altitudeKm = 550;
    const inclinationDeg = orbitReport({ altitudeKm, inclinationDeg: 53 }).sunSyncInclinationDeg!;
    expect(orbitReport({ altitudeKm, inclinationDeg }).betaCycleDays).toBe(Number.POSITIVE_INFINITY);
    expect(orbitReport(STARLINK).betaCycleDays).toBeCloseTo(65.8, 0);
  });

  it("is a pure function of the two numbers", () => {
    expect(orbitReport({ altitudeKm: 550, inclinationDeg: 53 })).toEqual(orbitReport(STARLINK));
    // Same altitude, different plane: the period is unchanged, the node rate is not.
    const steeper = orbitReport({ altitudeKm: 550, inclinationDeg: 97.6 });
    expect(steeper.rates.periodMinutes).toBe(orbitReport(STARLINK).rates.periodMinutes);
    expect(steeper.rates.nodeRateDegPerDay).toBeGreaterThan(0);
  });
});

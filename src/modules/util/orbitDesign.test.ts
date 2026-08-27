import { describe, expect, it } from "vitest";

import { orbitEnergyProfile } from "./energyStatistics";
import { createSatrec } from "./gp";
import {
  annualEclipseFreePlaneFraction,
  betaDeg,
  betaExchangeRateKmPerDegree,
  designPoint,
  eclipseFreePlaneFraction,
  maxReachableBetaDeg,
  minInclinationForEclipseFreeDeg,
} from "./orbitDesign";
import { dawnDuskBetaDeg, eclipseFreeBetaDeg, ssoRaanDeg, sunRightAscensionDeg, sunSyncInclinationDeg } from "./sunSynchronous";
import { WALKER_EPOCH_ISO, walkerDeltaRecords } from "./walkerDelta";

const EPOCH = new Date(WALKER_EPOCH_ISO);

describe("betaDeg", () => {
  it("agrees with the dawn-dusk special case at a node 90° from the sun", () => {
    for (const inclination of [30, 53, 70, 97.6]) {
      for (const declination of [-23.44, -10, 0, 12, 23.44]) {
        expect(betaDeg(inclination, 90, declination)).toBeCloseTo(dawnDuskBetaDeg(inclination, declination), 9);
      }
    }
  });

  it("is zero for a noon-midnight equatorial plane at equinox, where the sun lies in the plane", () => {
    expect(betaDeg(0, 0, 0)).toBeCloseTo(0, 9);
    expect(betaDeg(53, 0, 0)).toBeCloseTo(0, 9);
  });

  it("reads the declination alone for a polar plane at noon-midnight", () => {
    // cos i = 0 kills the second term for i = 90, so the node term is all there is …
    expect(betaDeg(90, 0, 20)).toBeCloseTo(0, 9);
    // … and at a dawn-dusk node a polar plane sees the sun almost broadside.
    expect(betaDeg(90, 90, 0)).toBeCloseTo(90, 9);
  });

  it("is antisymmetric in the node angle", () => {
    expect(betaDeg(53, 90, 10)).toBeCloseTo(-betaDeg(53, -90, -10), 9);
  });
});

describe("maxReachableBetaDeg", () => {
  it("is i + 23.44 below the fold", () => {
    expect(maxReachableBetaDeg(30)).toBeCloseTo(53.44, 2);
    expect(maxReachableBetaDeg(53)).toBeCloseTo(76.44, 2);
  });

  it("reaches 90° for any inclination that can put the sun on its orbit normal", () => {
    // 66.56° = 90 − 23.44 is where the fold begins.
    expect(maxReachableBetaDeg(70)).toBeGreaterThan(86);
    expect(maxReachableBetaDeg(90)).toBeCloseTo(90, 6);
    expect(maxReachableBetaDeg(97.6)).toBeGreaterThan(82);
  });

  it("is symmetric about a polar orbit", () => {
    expect(maxReachableBetaDeg(80)).toBeCloseTo(maxReachableBetaDeg(100), 6);
  });
});

describe("eclipseFreePlaneFraction", () => {
  it("is zero where no plane can reach the required β", () => {
    // 30° at 550 km can reach 53.4° and needs 67.0°.
    expect(eclipseFreePlaneFraction(550, 30, 0)).toBe(0);
  });

  it("is positive at 53° / 550 km near a solstice, and zero at equinox", () => {
    // The finding from the Starlink report, reproduced from geometry alone: the shell
    // has eclipse-free planes at the solstices and none at the equinoxes.
    expect(eclipseFreePlaneFraction(550, 53, -23.44)).toBeGreaterThan(0);
    expect(eclipseFreePlaneFraction(550, 53, 23.44)).toBeGreaterThan(0);
    expect(eclipseFreePlaneFraction(550, 53, 0)).toBe(0);
  });

  it("rises with altitude at a fixed inclination", () => {
    const low = annualEclipseFreePlaneFraction(550, 70);
    const high = annualEclipseFreePlaneFraction(1200, 70);
    expect(high).toBeGreaterThan(low);
  });

  it("rises with inclination at a fixed altitude, up to polar", () => {
    const fractions = [40, 55, 70, 85].map((inclination) => annualEclipseFreePlaneFraction(700, inclination));
    for (const [index, fraction] of fractions.slice(1).entries()) {
      expect(fraction).toBeGreaterThanOrEqual(fractions[index]!);
    }
  });

  it("never exceeds one or falls below zero", () => {
    for (const altitude of [400, 900, 2000]) {
      for (const inclination of [0, 45, 90, 135, 180]) {
        const fraction = annualEclipseFreePlaneFraction(altitude, inclination);
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("minInclinationForEclipseFreeDeg", () => {
  it("is about 43.5° at 550 km, where the shadow demands 67°", () => {
    // 67.0 − 23.44 = 43.6: the lowest inclination whose best case reaches the shadow's edge.
    const minimum = minInclinationForEclipseFreeDeg(550)!;
    expect(minimum).toBeGreaterThan(42);
    expect(minimum).toBeLessThan(45);
    expect(maxReachableBetaDeg(minimum)).toBeGreaterThanOrEqual(eclipseFreeBetaDeg(550));
  });

  it("falls as the orbit rises", () => {
    expect(minInclinationForEclipseFreeDeg(1500)!).toBeLessThan(minInclinationForEclipseFreeDeg(550)!);
  });

  it("is answerable at every altitude a satellite flies, because 90° can always reach it", () => {
    for (const altitude of [200, 550, 2000]) {
      expect(minInclinationForEclipseFreeDeg(altitude)).toBeDefined();
    }
  });
});

describe("betaExchangeRateKmPerDegree", () => {
  it("prices a degree of inclination at tens of kilometres of altitude in LEO", () => {
    const rate = betaExchangeRateKmPerDegree(550);
    expect(rate).toBeGreaterThan(30);
    expect(rate).toBeLessThan(80);
  });

  it("gets more expensive as the orbit rises, because the shadow shrinks more slowly", () => {
    expect(betaExchangeRateKmPerDegree(1500)).toBeGreaterThan(betaExchangeRateKmPerDegree(550));
  });

  it("matches a finite difference of the shadow condition", () => {
    const altitude = 700;
    const rate = betaExchangeRateKmPerDegree(altitude);
    const measured = eclipseFreeBetaDeg(altitude) - eclipseFreeBetaDeg(altitude + rate);
    // One degree of β for one exchange-rate's worth of altitude, by construction.
    expect(measured).toBeCloseTo(1, 1);
  });
});

describe("the map against the territory", () => {
  // The design sweep is closed-form geometry; the energy statistics propagate SGP4. They
  // are allowed to disagree slightly — the sweep uses a mean-element β and the propagated
  // one uses SGP4's own position — but not about whether an orbit is eclipsed.
  function propagatedEclipseFraction(altitudeKm: number, inclinationDeg: number, nodeSunAngleDeg: number, at: Date) {
    const raanOffsetDeg = (sunRightAscensionDeg(at) + nodeSunAngleDeg + 360) % 360;
    const [record] = walkerDeltaRecords({ total: 1, planes: 1, phasing: 0, inclinationDeg, altitudeKm, raanSpanDeg: 360, raanOffsetDeg }, at);
    return orbitEnergyProfile(createSatrec(record!), at, "normal").eclipseFraction;
  }

  it("agrees that a dawn-dusk plane at 53° / 550 km is eclipse-free at the June solstice", () => {
    // `sin β = sin(i + δ)` at a +90° node, so the good season is when the sun is *north*.
    // The −90° node — the other dawn-dusk orientation — has the opposite season, which is
    // why a 72-plane shell has eclipse-free planes at both solstices.
    const at = new Date("2026-06-21T12:00:00Z");
    expect(betaDeg(53, 90, 23.44)).toBeGreaterThan(eclipseFreeBetaDeg(550));
    expect(propagatedEclipseFraction(550, 53, 90, at)).toBe(0);
  });

  it("agrees that the same node half a year later is not", () => {
    const at = new Date("2026-12-21T12:00:00Z");
    expect(betaDeg(53, 90, -23.44)).toBeLessThan(eclipseFreeBetaDeg(550));
    expect(propagatedEclipseFraction(550, 53, 90, at)).toBeGreaterThan(0.2);
  });

  it("agrees that a noon-midnight plane is eclipsed whatever the season", () => {
    for (const iso of ["2026-06-21T12:00:00Z", "2026-12-21T12:00:00Z"]) {
      expect(propagatedEclipseFraction(550, 53, 0, new Date(iso))).toBeGreaterThan(0.2);
    }
  });

  it("agrees that 30° / 550 km is eclipsed whatever the node and whatever the season", () => {
    for (const node of [0, 45, 90, 135]) {
      expect(propagatedEclipseFraction(550, 30, node, new Date("2026-06-21T12:00:00Z"))).toBeGreaterThan(0.15);
    }
    expect(annualEclipseFreePlaneFraction(550, 30)).toBe(0);
  });

  it("places a sun-synchronous dawn-dusk plane where ssoRaanDeg puts it", () => {
    // The node angle this module reasons in is exactly what ssoRaanDeg encodes.
    const inclination = sunSyncInclinationDeg(700)!;
    const raan = ssoRaanDeg("dawn-dusk", EPOCH);
    expect((raan - sunRightAscensionDeg(EPOCH) + 360) % 360).toBeCloseTo(90, 6);
    expect(betaDeg(inclination, 90, 0)).toBeCloseTo(180 - inclination, 6);
  });
});

describe("designPoint", () => {
  it("reports both sides of the comparison and the verdict", () => {
    const point = designPoint(550, 53, -23.44);
    expect(point.requiredBetaDeg).toBeCloseTo(eclipseFreeBetaDeg(550), 9);
    expect(point.maxBetaDeg).toBeCloseTo(76.44, 1);
    expect(point.everEclipseFree).toBe(true);
    expect(point.planeFractionNow).toBeGreaterThan(0);
    expect(point.planeFractionAnnual).toBeGreaterThan(0);
    expect(point.planeFractionAnnual).toBeLessThan(point.planeFractionNow);
  });

  it("says never for a low-inclination low orbit", () => {
    const point = designPoint(400, 20, 0);
    expect(point.everEclipseFree).toBe(false);
    expect(point.planeFractionAnnual).toBe(0);
  });
});

import { constants, propagate } from "satellite.js";
import { describe, expect, it } from "vitest";

import { createSatrec } from "./gp";
import { illuminationTimeline } from "./illumination";
import {
  ALWAYS_SUNLIT_MARGIN_DEG,
  alwaysSunlitAltitudeBandKm,
  alwaysSunlitVerdict,
  dawnDuskBetaDeg,
  dawnDuskBetaRangeDeg,
  eclipseFreeBetaDeg,
  nodalPrecessionDegPerDay,
  representativeAlwaysSunlitAltitudeKm,
  ssoRaanDeg,
  sunRightAscensionDeg,
  sunSyncInclinationDeg,
  sunSyncWalkerParams,
  SUN_DEG_PER_DAY,
} from "./sunSynchronous";
import { encodeWalker, walkerDeltaRecords, WALKER_EPOCH_ISO } from "./walkerDelta";

const EPOCH = new Date(WALKER_EPOCH_ISO);

describe("sunSyncInclinationDeg", () => {
  // The published inclinations for flown sun-synchronous missions. A secular J₂
  // inversion should land within a couple of tenths of a degree of each.
  it.each([
    ["Sentinel-2 at 786 km", 786, 98.62],
    ["Sentinel-1 at 693 km", 693, 98.18],
    ["TerraSAR-X at 514 km", 514, 97.44],
    ["a 600 km orbit", 600, 97.79],
    ["a 1000 km orbit", 1000, 99.48],
  ])("matches the known inclination for %s", (_label, altitudeKm, expected) => {
    // Within 0.15°: this is a secular J₂ inversion, and the published figures come
    // from mean elements chosen for a repeat ground track. Sentinel-2 is the widest
    // miss at 0.08°.
    expect(Math.abs(sunSyncInclinationDeg(altitudeKm)! - expected)).toBeLessThan(0.15);
  });

  it("is always retrograde, because only a retrograde node turns the right way", () => {
    for (const altitude of [300, 700, 1500, 3000]) {
      expect(sunSyncInclinationDeg(altitude)!).toBeGreaterThan(90);
    }
  });

  it("gets steeper as the orbit rises", () => {
    const inclinations = [400, 800, 1200, 2000].map((altitude) => sunSyncInclinationDeg(altitude)!);
    for (const [index, inclination] of inclinations.slice(1).entries()) {
      expect(inclination).toBeGreaterThan(inclinations[index]!);
    }
  });

  it("gives up where no inclination can keep pace with the sun", () => {
    // cos i passes −1 somewhere below 6000 km; above that the orbit simply cannot be
    // made sun-synchronous, which is a fact about the orbit and not a solver failure.
    expect(sunSyncInclinationDeg(6500)).toBeUndefined();
    expect(sunSyncInclinationDeg(-100)).toBeUndefined();
    expect(sunSyncInclinationDeg(Number.NaN)).toBeUndefined();
  });

  it("refuses an eccentricity it cannot mean", () => {
    expect(sunSyncInclinationDeg(700, 1)).toBeUndefined();
    expect(sunSyncInclinationDeg(700, -0.1)).toBeUndefined();
  });

  it("reproduces the sun's own rate when read back through the same formula", () => {
    // The round trip: the inclination this returns, put back into the precession
    // formula, has to give the rate it was solved for.
    const altitudeKm = 700;
    const inclinationDeg = sunSyncInclinationDeg(altitudeKm)!;
    const record = walkerDeltaRecords({ total: 1, planes: 1, phasing: 0, inclinationDeg, altitudeKm, raanSpanDeg: 360 }, EPOCH)[0]!;
    const satrec = createSatrec(record);
    const { no, a, ecco, inclo } = satrec;
    const oneMinusESquared = 1 - ecco * ecco;
    const ratePerMinute = (-1.5 * constants.j2 * no * Math.cos(inclo)) / (a * a * oneMinusESquared * oneMinusESquared);
    const degPerDay = ratePerMinute * (180 / Math.PI) * 1440;
    // Through SGP4's recovered elements rather than the two-body ones, so a few
    // hundredths of a degree a day is the agreement to expect.
    expect(degPerDay).toBeCloseTo(SUN_DEG_PER_DAY, 1);
  });
});

describe("nodalPrecessionDegPerDay", () => {
  it("gives the sun's own rate back at a sun-synchronous inclination", () => {
    for (const altitude of [500, 700, 1000, 1500]) {
      const inclination = sunSyncInclinationDeg(altitude)!;
      expect(nodalPrecessionDegPerDay(altitude, inclination)).toBeCloseTo(SUN_DEG_PER_DAY, 6);
    }
  });

  it("regresses westward for a prograde orbit, at about 5°/day for the ISS", () => {
    // 420 km, 51.6°: the textbook figure is about −5°/day.
    expect(nodalPrecessionDegPerDay(420, 51.6)).toBeCloseTo(-5, 0);
  });

  it("is zero for a polar orbit, where the bulge has no lever arm", () => {
    expect(nodalPrecessionDegPerDay(700, 90)).toBeCloseTo(0, 9);
  });

  it("is slower for a higher orbit, because the bulge is further away", () => {
    expect(Math.abs(nodalPrecessionDegPerDay(2000, 51.6))).toBeLessThan(Math.abs(nodalPrecessionDegPerDay(400, 51.6)));
  });

  it("says an orbit is nearly fixed, not exactly: a few degrees a day at most in LEO", () => {
    // The claim the panel makes. Equatorial LEO is the fastest case.
    expect(Math.abs(nodalPrecessionDegPerDay(300, 0))).toBeLessThan(11);
  });

  it("declines inputs it cannot mean", () => {
    expect(nodalPrecessionDegPerDay(-10, 51.6)).toBeNaN();
    expect(nodalPrecessionDegPerDay(700, Number.NaN)).toBeNaN();
  });
});

describe("eclipseFreeBetaDeg", () => {
  it("is the half-angle the Earth subtends from the orbit", () => {
    expect(eclipseFreeBetaDeg(0)).toBeCloseTo(90, 6);
    expect(eclipseFreeBetaDeg(700)).toBeCloseTo(64.3, 1);
    expect(eclipseFreeBetaDeg(1500)).toBeCloseTo(54.06, 1);
    expect(eclipseFreeBetaDeg(35786)).toBeCloseTo(8.7, 1);
  });

  it("falls as the orbit rises, which is what buys the sunlight", () => {
    expect(eclipseFreeBetaDeg(1500)).toBeLessThan(eclipseFreeBetaDeg(700));
  });
});

describe("dawnDuskBetaDeg", () => {
  it("reads sin(i + δ), so a retrograde plane is at its best when the sun is south", () => {
    const inclination = 98.2;
    const june = dawnDuskBetaDeg(inclination, 23.44);
    const december = dawnDuskBetaDeg(inclination, -23.44);
    expect(december).toBeGreaterThan(june);
    // i + δ folded back through the sine: 74.76° in December, 58.36° in June.
    expect(december).toBeCloseTo(74.76, 1);
    expect(june).toBeCloseTo(58.36, 1);
  });

  it("swings by twice the obliquity over a year", () => {
    const { minDeg, maxDeg } = dawnDuskBetaRangeDeg(98.2);
    expect(maxDeg - minDeg).toBeGreaterThan(20);
    expect(maxDeg).toBeLessThanOrEqual(90);
    expect(minDeg).toBeGreaterThan(0);
  });
});

describe("alwaysSunlitVerdict", () => {
  it("says no for every altitude anyone actually flies a dawn-dusk mission at", () => {
    for (const altitude of [514, 693, 786, 1000]) {
      const verdict = alwaysSunlitVerdict(altitude);
      expect(verdict.alwaysSunlit, `${altitude} km`).toBe(false);
      // And it is close — these orbits are sunlit for much of the year, just not all.
      expect(verdict.worstBetaDeg).toBeGreaterThan(verdict.requiredBetaDeg - 12);
    }
  });

  it("says yes inside the band", () => {
    const verdict = alwaysSunlitVerdict(2000);
    expect(verdict.alwaysSunlit).toBe(true);
    expect(verdict.worstBetaDeg).toBeGreaterThan(verdict.requiredBetaDeg);
  });

  it("says no again far above the band, where sun-synchrony has run away", () => {
    // 5000 km wants i ≈ 139°, which leaves β under 20° against a required 35°.
    const verdict = alwaysSunlitVerdict(5000);
    expect(verdict.inclinationDeg!).toBeGreaterThan(130);
    expect(verdict.alwaysSunlit).toBe(false);
  });

  it("reports both sides of the comparison it made", () => {
    const verdict = alwaysSunlitVerdict(700);
    expect(verdict.inclinationDeg!).toBeCloseTo(98.2, 1);
    expect(verdict.requiredBetaDeg).toBeCloseTo(eclipseFreeBetaDeg(700) + ALWAYS_SUNLIT_MARGIN_DEG, 6);
  });

  it("says no, rather than throwing, where there is no sun-synchronous inclination", () => {
    const verdict = alwaysSunlitVerdict(6500);
    expect(verdict.inclinationDeg).toBeUndefined();
    expect(verdict.alwaysSunlit).toBe(false);
  });
});

describe("alwaysSunlitAltitudeBandKm", () => {
  const band = alwaysSunlitAltitudeBandKm()!;

  it("is a band rather than a floor, because both curves fall with altitude", () => {
    expect(band).toBeDefined();
    expect(band.lowestKm).toBeGreaterThan(1500);
    expect(band.lowestKm).toBeLessThan(1700);
    expect(band.highestKm).toBeGreaterThan(3000);
    expect(band.highestKm).toBeLessThan(3200);
  });

  it("holds inside and fails outside, at both edges", () => {
    expect(alwaysSunlitVerdict(band.lowestKm).alwaysSunlit).toBe(true);
    expect(alwaysSunlitVerdict(band.highestKm).alwaysSunlit).toBe(true);
    expect(alwaysSunlitVerdict(band.lowestKm - 60).alwaysSunlit).toBe(false);
    expect(alwaysSunlitVerdict(band.highestKm + 60).alwaysSunlit).toBe(false);
  });

  it("excludes every flown dawn-dusk mission", () => {
    for (const altitude of [514, 693, 786]) {
      expect(altitude).toBeLessThan(band.lowestKm);
    }
  });

  it("offers a representative altitude near the interesting edge", () => {
    const representative = representativeAlwaysSunlitAltitudeKm()!;
    expect(alwaysSunlitVerdict(representative).alwaysSunlit).toBe(true);
    expect(representative).toBeGreaterThan(band.lowestKm);
    expect(representative).toBeLessThan((band.lowestKm + band.highestKm) / 2);
  });
});

describe("ssoRaanDeg", () => {
  it("puts a dawn-dusk node 90° from the sun and a noon-midnight node on it", () => {
    const sun = sunRightAscensionDeg(EPOCH);
    expect(ssoRaanDeg("noon-midnight", EPOCH)).toBeCloseTo(sun, 6);
    expect(ssoRaanDeg("dawn-dusk", EPOCH)).toBeCloseTo((sun + 90) % 360, 6);
  });

  it("follows the sun round over a year", () => {
    const january = ssoRaanDeg("dawn-dusk", EPOCH);
    const july = ssoRaanDeg("dawn-dusk", new Date(EPOCH.getTime() + 182 * 86400_000));
    const apart = Math.abs(((july - january + 540) % 360) - 180);
    expect(apart).toBeGreaterThan(170);
  });
});

describe("sunSyncWalkerParams", () => {
  it("builds a pattern with the computed inclination and a sun-relative node", () => {
    const params = sunSyncWalkerParams({ altitudeKm: 1500, total: 12, plane: "dawn-dusk" }, EPOCH)!;
    expect(params.inclinationDeg).toBeCloseTo(sunSyncInclinationDeg(1500)!, 2);
    expect(params.raanOffsetDeg!).toBeCloseTo(ssoRaanDeg("dawn-dusk", EPOCH), 2);
    expect(params.planes).toBe(1);
    expect(params.total).toBe(12);
  });

  it("differs from its noon-midnight twin by the node and nothing else", () => {
    const dawn = sunSyncWalkerParams({ altitudeKm: 1500, total: 12, plane: "dawn-dusk" }, EPOCH)!;
    const noon = sunSyncWalkerParams({ altitudeKm: 1500, total: 12, plane: "noon-midnight" }, EPOCH)!;
    expect({ ...dawn, raanOffsetDeg: 0 }).toEqual({ ...noon, raanOffsetDeg: 0 });
    // Wrapped: the dawn node is 90° *ahead*, which a raw subtraction reports as −270
    // whenever the sum crosses 360.
    expect((dawn.raanOffsetDeg! - noon.raanOffsetDeg! + 360) % 360).toBeCloseTo(90, 2);
  });

  it("survives the wire form, offset and all", () => {
    const params = sunSyncWalkerParams({ altitudeKm: 1500, total: 12, plane: "dawn-dusk" }, EPOCH)!;
    expect(encodeWalker(params)).toContain("+");
    expect(encodeWalker(params)).toContain(`${params.inclinationDeg}:12/1/0@1500`);
  });

  it("declines an altitude with no sun-synchronous inclination", () => {
    expect(sunSyncWalkerParams({ altitudeKm: 6500, total: 4, plane: "dawn-dusk" }, EPOCH)).toBeUndefined();
  });
});

describe("what the viewer's own illumination model makes of them", () => {
  function timelineFor(altitudeKm: number, plane: "dawn-dusk" | "noon-midnight", at: Date) {
    const params = sunSyncWalkerParams({ altitudeKm, total: 1, plane }, EPOCH)!;
    const satrec = createSatrec(walkerDeltaRecords(params, EPOCH)[0]!);
    const periodMinutes = (2 * Math.PI) / satrec.no;
    return illuminationTimeline(satrec, at, periodMinutes * 60, 10, "normal");
  }

  it("finds no eclipse at all on the computed always-sunlit orbit, at either solstice", () => {
    const altitude = representativeAlwaysSunlitAltitudeKm()!;
    // The two worst moments of the year for a dawn-dusk plane are the solstices; the
    // claim is about the whole year, so both have to hold.
    for (const iso of ["2026-06-21T00:00:00Z", "2026-12-21T00:00:00Z"]) {
      const timeline = timelineFor(altitude, "dawn-dusk", new Date(iso));
      expect(timeline.fractions.umbra ?? 0, iso).toBe(0);
      expect(timeline.fractions.penumbra ?? 0, iso).toBe(0);
    }
  });

  it("finds a deep eclipse on the same orbit turned a quarter turn", () => {
    const altitude = representativeAlwaysSunlitAltitudeKm()!;
    const timeline = timelineFor(altitude, "noon-midnight", new Date("2026-06-21T00:00:00Z"));
    expect(timeline.fractions.umbra ?? 0).toBeGreaterThan(0.2);
  });

  it("still eclipses a 700 km dawn-dusk orbit at the wrong end of the year", () => {
    // The point of the threshold: real dawn-dusk missions are not always sunlit.
    const worst = ["2026-06-21T00:00:00Z", "2026-12-21T00:00:00Z"].map((iso) => timelineFor(700, "dawn-dusk", new Date(iso)).fractions.umbra ?? 0);
    expect(Math.max(...worst)).toBeGreaterThan(0);
  });

  it("keeps the always-sunlit orbit fully powered under an orbit-normal panel", () => {
    const altitude = representativeAlwaysSunlitAltitudeKm()!;
    const timeline = timelineFor(altitude, "dawn-dusk", new Date("2026-06-21T00:00:00Z"));
    // β is high, so the orbit normal points near the sun all the way round: this is
    // the orbit's selling point, and the reason the panel model matters.
    expect(timeline.fractions.sunlit_on ?? 0).toBe(1);
  });

  it("propagates to the altitude it was asked for", () => {
    const params = sunSyncWalkerParams({ altitudeKm: 1500, total: 1, plane: "dawn-dusk" }, EPOCH)!;
    const satrec = createSatrec(walkerDeltaRecords(params, EPOCH)[0]!);
    const { x, y, z } = propagate(satrec, EPOCH)!.position;
    const altitude = Math.sqrt(x * x + y * y + z * z) - constants.earthRadius;
    expect(altitude).toBeGreaterThan(1480);
    expect(altitude).toBeLessThan(1510);
  });
});

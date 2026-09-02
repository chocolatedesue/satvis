// The multi-shell layout rules: the two secular rates, the companion they pick
// out, and the four verdicts a shell pair can earn. The numbers here are the
// ones scripts/derive-isl-topology.ts then flies with SGP4 — this file checks
// the closed form is self-consistent and agrees with the modules it restates,
// the script checks it agrees with a propagator.
import { describe, expect, test } from "vitest";

import {
  bestResonance,
  configurationReturns,
  coPrecessingCeilingKm,
  coPrecessingInclinationDeg,
  MAX_REPEAT_REVOLUTIONS,
  minSatellitesPerRing,
  resonantCompanion,
  searchStableShellLayouts,
  shellPairLayout,
  shellRates,
  type ShellOrbit,
} from "./shellLayout";
import { nodalPrecessionDegPerDay, SUN_DEG_PER_DAY, sunSyncInclinationDeg } from "./sunSynchronous";
import { meanMotionRevPerDay, walkerPatternAt, type WalkerDeltaParams } from "./walkerDelta";

const STARLINK_SHELL: ShellOrbit = { altitudeKm: 550, inclinationDeg: 53 };
const REFERENCE_PATTERN: WalkerDeltaParams = { total: 40, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };

describe("shellRates", () => {
  test("restates walkerDelta's mean motion exactly", () => {
    for (const altitudeKm of [200, 550, 780, 1200, 1760, 5000]) {
      expect(shellRates({ altitudeKm, inclinationDeg: 53 }).meanMotionRevPerDay).toBe(meanMotionRevPerDay(altitudeKm));
    }
  });

  test("restates sunSynchronous's node rate exactly", () => {
    for (const [altitudeKm, inclinationDeg] of [
      [550, 53],
      [780, 86.4],
      [1200, 97.6],
      [400, 51.6],
    ] as const) {
      expect(shellRates({ altitudeKm, inclinationDeg }).nodeRateDegPerDay).toBeCloseTo(nodalPrecessionDegPerDay(altitudeKm, inclinationDeg), 12);
    }
  });

  test("the along-track rate is the mean motion, corrected by a part in a thousand", () => {
    const rates = shellRates(STARLINK_SHELL);
    const keplerian = rates.meanMotionRevPerDay * 360;
    // J2 moves the node the angle is measured from and the perigee it runs to;
    // what is left is under a tenth of a percent, and it is what decides whether
    // a repeat cycle is exact after fifty orbits.
    expect(rates.alongTrackRateDegPerDay / keplerian).toBeGreaterThan(0.999);
    expect(rates.alongTrackRateDegPerDay / keplerian).toBeLessThan(1.001);
    expect(rates.alongTrackRateDegPerDay).not.toBe(keplerian);
  });

  test("period and mean motion are each other's inverse", () => {
    const rates = shellRates(STARLINK_SHELL);
    expect(rates.periodMinutes).toBeCloseTo(95.65, 2);
    expect(rates.periodMinutes * rates.meanMotionRevPerDay).toBeCloseTo(1440, 9);
  });
});

describe("coPrecessingInclinationDeg", () => {
  test("the companion it picks has the reference's node rate", () => {
    for (const altitudeKm of [300, 700, 900, 1200, 1500]) {
      const inclinationDeg = coPrecessingInclinationDeg(STARLINK_SHELL, altitudeKm);
      expect(inclinationDeg).toBeDefined();
      expect(shellRates({ altitudeKm, inclinationDeg: inclinationDeg as number }).nodeRateDegPerDay).toBeCloseTo(shellRates(STARLINK_SHELL).nodeRateDegPerDay, 10);
    }
  });

  test("a higher companion needs a shallower inclination, monotonically", () => {
    const inclinations = [600, 800, 1000, 1200].map((altitudeKm) => coPrecessingInclinationDeg(STARLINK_SHELL, altitudeKm) as number);
    expect(inclinations).toEqual([...inclinations].toSorted((a, b) => b - a));
    expect(coPrecessingInclinationDeg(STARLINK_SHELL, 1200)).toBeCloseTo(34.54, 1);
  });

  test("a sun-synchronous reference asks every companion to be sun-synchronous too", () => {
    // The one node rate with a name: match it at another altitude and the
    // inclination that comes back is that altitude's own SSO inclination.
    const sso: ShellOrbit = { altitudeKm: 600, inclinationDeg: sunSyncInclinationDeg(600) as number };
    expect(shellRates(sso).nodeRateDegPerDay).toBeCloseTo(SUN_DEG_PER_DAY, 9);
    for (const altitudeKm of [400, 800, 1200]) {
      expect(coPrecessingInclinationDeg(sso, altitudeKm)).toBeCloseTo(sunSyncInclinationDeg(altitudeKm) as number, 6);
    }
  });

  test("undefined above the ceiling, defined below it", () => {
    const ceiling = coPrecessingCeilingKm(STARLINK_SHELL);
    expect(ceiling).toBeGreaterThan(1600);
    expect(ceiling).toBeLessThan(1700);
    expect(coPrecessingInclinationDeg(STARLINK_SHELL, ceiling - 1)).toBeDefined();
    expect(coPrecessingInclinationDeg(STARLINK_SHELL, ceiling + 1)).toBeUndefined();
    // At the ceiling the companion has run out of inclination to give: its plane
    // is equatorial, which is as fast as a node at that altitude can precess.
    expect(coPrecessingInclinationDeg(STARLINK_SHELL, ceiling)).toBeCloseTo(0, 3);
  });

  test("a polar reference has all but no ceiling — its node barely moves, and any polar companion matches", () => {
    // cos 90° is 6e-17 rather than 0, so the ceiling is a number rather than
    // Infinity — but a number past the moon, which is the same answer.
    expect(coPrecessingCeilingKm({ altitudeKm: 550, inclinationDeg: 90 })).toBeGreaterThan(1e6);
    expect(coPrecessingCeilingKm({ altitudeKm: 550, inclinationDeg: 89 })).toBeGreaterThan(15000);
    expect(coPrecessingInclinationDeg({ altitudeKm: 550, inclinationDeg: 90 }, 20000)).toBeCloseTo(90, 9);
  });
});

describe("bestResonance", () => {
  test("an exact ratio slips by nothing", () => {
    const resonance = bestResonance(8000, 7000);
    expect(resonance).toMatchObject({ referenceRevolutions: 8, companionRevolutions: 7 });
    expect(resonance?.slipDegPerCycle).toBeCloseTo(0, 9);
  });

  test("equal rates repeat every single revolution", () => {
    expect(bestResonance(5423, 5423)).toMatchObject({ referenceRevolutions: 1, companionRevolutions: 1 });
  });

  test("the cycle is the reference's revolutions at its own rate", () => {
    const rate = shellRates(STARLINK_SHELL).alongTrackRateDegPerDay;
    const resonance = bestResonance(rate, (rate * 7) / 8);
    expect(resonance?.repeatHours).toBeCloseTo((8 * 24 * 360) / rate, 6);
  });

  test("a rate of zero or less has no resonance to report", () => {
    expect(bestResonance(0, 100)).toBeUndefined();
    expect(bestResonance(100, -1)).toBeUndefined();
  });
});

describe("resonantCompanion", () => {
  test("8 reference orbits to 7 of the companion lands the 1200 km shell", () => {
    const layout = resonantCompanion(STARLINK_SHELL, 8, 7);
    expect(layout).toBeDefined();
    expect(layout?.altitudeKm).toBeCloseTo(1202, 0);
    expect(layout?.inclinationDeg).toBeCloseTo(34.47, 1);
    expect(layout?.resonance.repeatHours).toBeCloseTo(12.75, 1);
    // Both conditions hold at once, which is the whole claim.
    expect(Math.abs(layout?.nodeShearDegPerDay as number)).toBeLessThan(1e-9);
    expect(layout?.resonance.slipDegPerCycle).toBeLessThan(1e-6);
    expect(layout?.minPerPlane).toBe(6);
  });

  test("the companion's own rates satisfy both conditions when re-derived", () => {
    const layout = resonantCompanion(STARLINK_SHELL, 8, 7) as NonNullable<ReturnType<typeof resonantCompanion>>;
    const pair = shellPairLayout(STARLINK_SHELL, { altitudeKm: layout.altitudeKm, inclinationDeg: layout.inclinationDeg });
    expect(pair.verdict).toBe("repeating");
    expect(pair.resonance).toMatchObject({ referenceRevolutions: 8, companionRevolutions: 7 });
  });

  test("a resonance beyond the co-precession ceiling has no companion", () => {
    // 2:1 wants an altitude 59% higher, far past where any inclination can keep
    // a 53° shell's node company.
    expect(resonantCompanion(STARLINK_SHELL, 2, 1)).toBeUndefined();
  });

  test("nonsense revolution counts are refused rather than solved", () => {
    expect(resonantCompanion(STARLINK_SHELL, 0, 1)).toBeUndefined();
    expect(resonantCompanion(STARLINK_SHELL, 8, 7.5)).toBeUndefined();
    expect(resonantCompanion(STARLINK_SHELL, -8, 7)).toBeUndefined();
  });
});

describe("shellPairLayout", () => {
  test("a shell against itself is rigid", () => {
    const pair = shellPairLayout(STARLINK_SHELL, STARLINK_SHELL);
    expect(pair.verdict).toBe("rigid");
    expect(pair.nodeShearDegPerDay).toBe(0);
    expect(pair.seamHoldDays).toBe(Number.POSITIVE_INFINITY);
    expect(pair.periodRatio).toBe(1);
  });

  test("the same altitude at a different inclination is phase-locked, not rigid", () => {
    // The stacked-shells demo's two 1200 km shells: along-track offsets frozen,
    // planes shearing at a couple of degrees a day.
    const pair = shellPairLayout({ altitudeKm: 1200, inclinationDeg: 70 }, { altitudeKm: 1200, inclinationDeg: 97.6 });
    expect(pair.verdict).toBe("phase-locked");
    expect(pair.periodRatio).toBe(1);
    expect(Math.abs(pair.nodeShearDegPerDay)).toBeGreaterThan(2);
    expect(pair.seamHoldDays).toBeLessThan(1);
  });

  test("a shell picked for its altitude alone drifts", () => {
    const pair = shellPairLayout(STARLINK_SHELL, { altitudeKm: 1200, inclinationDeg: 97.6 });
    expect(pair.verdict).toBe("drifting");
    expect(Math.abs(pair.nodeShearDegPerDay)).toBeGreaterThan(5);
  });

  test("a designed companion repeats", () => {
    const layout = resonantCompanion(STARLINK_SHELL, 8, 7) as NonNullable<ReturnType<typeof resonantCompanion>>;
    expect(shellPairLayout(STARLINK_SHELL, layout).verdict).toBe("repeating");
  });

  test("a node-locked pair holds its planes and slides its phases", () => {
    // Every co-precessing altitude is this until one is chosen that also closes
    // the cycle: the seam holds for years, the two satellites never meet twice.
    const inclinationDeg = coPrecessingInclinationDeg(STARLINK_SHELL, 1000) as number;
    const pair = shellPairLayout(STARLINK_SHELL, { altitudeKm: 1000, inclinationDeg });
    expect(pair.verdict).toBe("node-locked");
    expect(Math.abs(pair.nodeShearDegPerDay)).toBeLessThan(1e-9);
  });

  test("only the returning verdicts come back", () => {
    expect(configurationReturns("rigid")).toBe(true);
    expect(configurationReturns("repeating")).toBe(true);
    expect(configurationReturns("phase-locked")).toBe(true);
    expect(configurationReturns("node-locked")).toBe(false);
    expect(configurationReturns("drifting")).toBe(false);
  });
});

describe("searchStableShellLayouts", () => {
  test("every layout it returns is one shellPairLayout calls repeating", () => {
    const layouts = searchStableShellLayouts(STARLINK_SHELL, { limit: 8 });
    expect(layouts.length).toBeGreaterThan(3);
    for (const layout of layouts) {
      expect(shellPairLayout(STARLINK_SHELL, layout).verdict).toBe("repeating");
    }
  });

  test("shortest repeat cycle first", () => {
    const hours = searchStableShellLayouts(STARLINK_SHELL, { limit: 8 }).map((layout) => layout.resonance.repeatHours);
    expect(hours).toEqual([...hours].toSorted((a, b) => a - b));
  });

  test("the altitude band is respected, and the ceiling caps it below the band's top", () => {
    const layouts = searchStableShellLayouts(STARLINK_SHELL, { minAltitudeKm: 300, maxAltitudeKm: 2000, limit: 20 });
    const ceiling = coPrecessingCeilingKm(STARLINK_SHELL);
    for (const layout of layouts) {
      expect(layout.altitudeKm).toBeGreaterThanOrEqual(300);
      expect(layout.altitudeKm).toBeLessThanOrEqual(ceiling);
    }
    // Companions exist on both sides: a shorter cycle above, and — only at the
    // long-cycle end, where the altitude step is small — a few below.
    expect(layouts.some((layout) => layout.altitudeKm > STARLINK_SHELL.altitudeKm)).toBe(true);
    expect(layouts.some((layout) => layout.altitudeKm < STARLINK_SHELL.altitudeKm)).toBe(true);
  });

  test("a tighter cycle budget returns fewer layouts, all of them shorter", () => {
    const long = searchStableShellLayouts(STARLINK_SHELL, { limit: 50 });
    const short = searchStableShellLayouts(STARLINK_SHELL, { maxRevolutions: 8, limit: 50 });
    expect(short.length).toBeLessThan(long.length);
    for (const layout of short) {
      expect(layout.resonance.referenceRevolutions).toBeLessThanOrEqual(8);
    }
    expect(long.every((layout) => layout.resonance.referenceRevolutions <= MAX_REPEAT_REVOLUTIONS)).toBe(true);
  });

  test("a polar reference has companions on both sides of it", () => {
    const polar: ShellOrbit = { altitudeKm: 780, inclinationDeg: 86.4 };
    const layouts = searchStableShellLayouts(polar, { limit: 20 });
    expect(layouts.some((layout) => layout.altitudeKm > polar.altitudeKm)).toBe(true);
    expect(layouts.some((layout) => layout.altitudeKm < polar.altitudeKm)).toBe(true);
  });
});

describe("minSatellitesPerRing", () => {
  test("matches the thresholds the derivation prints", () => {
    expect(minSatellitesPerRing(550)).toBe(8);
    expect(minSatellitesPerRing(780)).toBe(7);
    expect(minSatellitesPerRing(1200)).toBe(6);
  });
});

describe("walkerPatternAt", () => {
  test("keeps the reference's plane structure and lifts the per-plane count to the ring rule", () => {
    const layout = resonantCompanion(STARLINK_SHELL, 8, 7) as NonNullable<ReturnType<typeof resonantCompanion>>;
    const pattern = walkerPatternAt(REFERENCE_PATTERN, layout, layout.minPerPlane) as WalkerDeltaParams;
    expect(pattern.planes).toBe(4);
    expect(pattern.phasing).toBe(1);
    expect(pattern.raanSpanDeg).toBe(360);
    // The reference flies 10 per plane, which already clears the 6 the companion's
    // altitude asks for, so the fleet keeps its shape.
    expect(pattern.total).toBe(40);
    expect(pattern.inclinationDeg).toBeCloseTo(34.47, 1);
  });

  test("raises a thin reference to the companion's ring minimum", () => {
    const thin: WalkerDeltaParams = { ...REFERENCE_PATTERN, total: 8, planes: 4 };
    const pattern = walkerPatternAt(thin, { altitudeKm: 1200, inclinationDeg: 34.5 }, minSatellitesPerRing(1200)) as WalkerDeltaParams;
    expect(pattern.total).toBe(24);
  });

  test("undefined when the result would not be a buildable pattern", () => {
    expect(walkerPatternAt(REFERENCE_PATTERN, { altitudeKm: 100, inclinationDeg: 34 })).toBeUndefined();
  });
});

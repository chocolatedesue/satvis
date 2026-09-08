// The contact curve is the claim a cluster row makes, drawn. These check the two
// things a reader would otherwise take on trust: that the curve comes back to where
// it started — the return, which is the whole content of a verdict — and that
// "in contact" means inside the pair's own horizon rather than merely near.
import { describe, expect, test } from "vitest";

import { contactSeries, rangeKm, type OrbitPhase } from "./clusterRange";
import { familyCycleHours, maxLinkRangeKm, shellFamily } from "./shellLayout";

/** A member sitting at the node with no phase offset — the satellite `1-1@wire` names. */
function member(altitudeKm: number, inclinationDeg: number, nodeDeg = 0): OrbitPhase {
  return { altitudeKm, inclinationDeg, nodeDeg, phaseDeg: 0 };
}

/** Five shells of a sun-synchronous family, and the cycle they really close. */
function family(): { members: OrbitPhase[]; cycleHours: number } {
  const shells = shellFamily({ altitudeKm: 650, inclinationDeg: 97.99 }, { cycleRevolutions: 15 });
  return {
    members: shells.map((shell) => member(shell.altitudeKm, shell.inclinationDeg)),
    cycleHours: familyCycleHours(shells),
  };
}

describe("cluster range", () => {
  test("two satellites on one orbit hold their separation", () => {
    // Same plane, fixed phase offset: the chord is 2r·sin(Δu/2), and neither J₂
    // rate touches it — the node carries both satellites round together.
    const lead = { ...member(550, 53), phaseDeg: 90 };
    expect(rangeKm(member(550, 53), lead, 0)).toBeCloseTo(rangeKm(member(550, 53), lead, 12), 3);
    expect(rangeKm(member(550, 53), lead, 0)).toBeCloseTo(2 * 6928 * Math.sin(Math.PI / 4), -2);
  });

  test("a designed family's curve returns to where it started", () => {
    // The claim every cluster row makes and nothing else in the panel can show:
    // one cycle later the geometry is the geometry. Slip tolerance is a degree of
    // arc, which at LEO is about 130 km, so a kilometre is a demanding bar.
    const { members, cycleHours } = family();
    const series = contactSeries(members, cycleHours);
    expect(series.closureKm).toBeLessThan(1);
    // And it is not trivially flat on the way — the whole point of drawing it is
    // that the distances breathe and still come back.
    const ranges = series.samples.map((sample) => sample.closestKm);
    expect(Math.max(...ranges) - Math.min(...ranges)).toBeGreaterThan(1000);
  });

  test("a pair that was not designed does not come back", () => {
    // Same two altitudes as two of the family's shells, inclination picked for
    // coverage instead: the planes shear, so the cycle closes on a different
    // geometry than it started from.
    const drifting = [member(650, 97.99), member(982, 70)];
    const series = contactSeries(drifting, family().cycleHours);
    expect(series.closureKm).toBeGreaterThan(100);
  });

  test("in contact means inside the pair's own horizon, sample by sample", () => {
    const a = member(550, 53);
    const b = member(1200, 70);
    const series = contactSeries([a, b], 24, 24);
    const horizon = maxLinkRangeKm(550, 1200);
    expect(series.pairs).toBe(1);
    expect(series.horizonKm).toBeCloseTo(horizon, 6);
    for (const sample of series.samples) {
      const expected = rangeKm(a, b, sample.hours) <= horizon ? 1 : 0;
      expect(sample.linkedPairs).toBe(expected);
      expect(sample.closestKm).toBeCloseTo(rangeKm(a, b, sample.hours), 6);
    }
  });

  test("a family has windows with nothing in contact, and the series says how much", () => {
    // The operational reading of the curve: a cluster that returns is not a
    // cluster that is always wired. Five shells spread over 1400 km of altitude
    // spend part of every cycle with no pair inside its horizon.
    const { members, cycleHours } = family();
    const series = contactSeries(members, cycleHours);
    const linked = series.samples.map((sample) => sample.linkedPairs);
    expect(Math.min(...linked)).toBe(0);
    expect(series.linkedFraction).toBeGreaterThan(0.5);
    expect(series.linkedFraction).toBeLessThan(1);
  });

  test("one member is not a cluster, and the series says so rather than dividing by zero", () => {
    const series = contactSeries([member(550, 53)], 24);
    expect(series.pairs).toBe(0);
    expect(series.linkedFraction).toBe(0);
    expect(series.closureKm).toBe(0);
  });
});

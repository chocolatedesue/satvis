import { describe, expect, it } from "vitest";

import { fleetContinuity } from "./fleetContinuity";

/** One satellite's power timeline, from a compact 0/1 string — 1 is powered. */
const row = (pattern: string): boolean[] => [...pattern].map((bit) => bit === "1");

describe("fleetContinuity", () => {
  it("answers zeros for an empty fleet or an empty timeline", () => {
    const empty = fleetContinuity([], 4);
    expect(empty).toMatchObject({ satellites: 0, samples: 0, meanSunlitFraction: 0, serviceOpportunity: 0, placement: [] });
    expect(empty.staticPlacementContinuity).toBeUndefined();
    expect(fleetContinuity([[]], 4)).toMatchObject({ satellites: 1, samples: 0 });
  });

  it("reports the fleet's plain power geometry", () => {
    // Two satellites: one lit 3/4 of the time, one 1/2. Mean 5/8, best 3/4.
    const report = fleetContinuity([row("1110"), row("1100")], 1);
    expect(report.satellites).toBe(2);
    expect(report.samples).toBe(4);
    expect(report.meanSunlitFraction).toBeCloseTo(0.625, 9);
    expect(report.bestSunlitFraction).toBeCloseTo(0.75, 9);
  });

  it("counts an instant as opportunity when enough satellites are lit at once", () => {
    // At no instant are both lit together — the conjunction never happens — but
    // each is lit alone half the time, so a 1-stage pipeline has full opportunity.
    const both = fleetContinuity([row("1100"), row("0011")], 1);
    expect(both.serviceOpportunity).toBe(1);
    const pair = fleetContinuity([row("1100"), row("0011")], 2);
    expect(pair.serviceOpportunity).toBe(0);
  });

  it("scores a fixed placement by its worst stage, not its best", () => {
    // Greedy picks the 3/4-lit satellite first, then the 1/2-lit one; the pair is
    // both-lit only at the two instants the darker one is lit, so the static
    // placement serves half the time — well under either's own fraction. That gap
    // is the conjunction the naive policy stalls on.
    const report = fleetContinuity([row("1110"), row("1100")], 2);
    expect(report.placement).toEqual([0, 1]);
    expect(report.staticPlacementContinuity).toBeCloseTo(0.5, 9);
    expect(report.staticPlacementContinuity).toBeLessThan(report.bestSunlitFraction);
  });

  it("caps the placement at the fleet size rather than repeating a satellite", () => {
    const report = fleetContinuity([row("1110"), row("1100")], 6);
    expect(report.placement).toEqual([0, 1]);
  });

  it("is deterministic on ties, keeping input order", () => {
    const report = fleetContinuity([row("1100"), row("1010")], 1);
    // Both lit half the time; the first satellite wins the single slot.
    expect(report.placement).toEqual([0]);
  });

  it("brackets what migration buys on a correlated fleet", () => {
    // Four satellites each dark for a distinct quarter of the orbit: any one is
    // lit 3/4 of the time, and no fixed 3-stage placement is ever fully safe
    // (each trio is simultaneously lit only one instant in four) — but at every
    // instant some trio *is* lit, so a migrated pipeline has full opportunity.
    // The two numbers are the reason the machinery exists.
    const report = fleetContinuity([row("1110"), row("1101"), row("1011"), row("0111")], 3);
    expect(report.meanSunlitFraction).toBeCloseTo(0.75, 9);
    expect(report.staticPlacementContinuity).toBeCloseTo(0.25, 9);
    expect(report.serviceOpportunity).toBe(1);
  });
});

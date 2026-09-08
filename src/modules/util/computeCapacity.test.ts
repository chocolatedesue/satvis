// The capacity model: a pipeline only runs while every stage has power, so the
// question is never "how sunny is the fleet" but "how often is every stage lit at
// once". These pin the two things that makes surprising — that plane diversity,
// not illumination, is what buys availability; and that the always-sunlit band
// really is always sunlit.
import { describe, expect, test } from "vitest";

import type { OrbitPhase } from "./clusterRange";
import { capacityReport, jointLitFraction, powerSeries, selectHosts } from "./computeCapacity";
import { sunSyncWalkerParams, type SsoPlane } from "./sunSynchronous";
import { walkerDeltaRecords, WALKER_EPOCH_ISO, type WalkerDeltaParams } from "./walkerDelta";

const EPOCH = new Date(WALKER_EPOCH_ISO);

/** A pattern's satellites, as the closed form wants them. */
function membersOf(params: WalkerDeltaParams): OrbitPhase[] {
  return walkerDeltaRecords(params, EPOCH).flatMap((record) =>
    record.kind === "omm" ? [{ altitudeKm: params.altitudeKm, inclinationDeg: params.inclinationDeg, nodeDeg: Number(record.omm.RA_OF_ASC_NODE), phaseDeg: Number(record.omm.MEAN_ANOMALY) }] : [],
  );
}

function seriesOf(members: OrbitPhase[], hours = 24) {
  return powerSeries(members, { start: EPOCH, hours, stepSeconds: 60 });
}

describe("compute capacity", () => {
  test("the always-sunlit band is always sunlit, and a quarter turn away it is not", () => {
    // The energy layer's own claim, read through the capacity model: same orbit,
    // same altitude, the only difference being which way the node faces.
    const lit = (plane: SsoPlane) => {
      const params = sunSyncWalkerParams({ altitudeKm: 1760, total: 1, planes: 1, plane }, EPOCH);
      return params ? (seriesOf(membersOf(params)).litFraction[0] ?? 0) : 0;
    };
    expect(lit("dawn-dusk")).toBeGreaterThan(0.99);
    expect(lit("noon-midnight")).toBeLessThan(lit("dawn-dusk") - 0.1);
  });

  test("four satellites in one plane never serve together, however sunny they are", () => {
    // The conjunction, and the reason a fleet's mean illumination is the wrong
    // number: these four are lit ~65% of the time each and ~0% of the time
    // together, because one plane enters and leaves the shadow as a unit.
    const series = seriesOf(membersOf({ total: 4, planes: 1, phasing: 0, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    for (const fraction of series.litFraction) {
      expect(fraction).toBeGreaterThan(0.5);
    }
    const hosts = selectHosts(series, 4);
    const report = capacityReport(series, hosts, 8);
    expect(report.servingFraction).toBeLessThan(0.05);
    // And it is not a placement problem: no four of the four are lit at once.
    expect(report.ceilingFraction).toBeLessThan(0.05);
  });

  test("spreading the same budget across planes is what buys availability", () => {
    // Same 24 satellites, same orbit: four planes instead of one, and the
    // pipeline runs essentially the whole time. Finding this set is what
    // `selectHosts` is for.
    const series = seriesOf(membersOf({ total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    const report = capacityReport(series, selectHosts(series, 4), 8);
    expect(report.servingFraction).toBeGreaterThan(0.95);
  });

  test("a deeper pipeline never serves more often", () => {
    // Monotone by construction — adding a stage adds a conjunction — so this is
    // the check that the report is not quietly rewarding a deeper cut.
    const series = seriesOf(membersOf({ total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    let previous = 1;
    for (const depth of [2, 4, 6, 8]) {
      const serving = capacityReport(series, selectHosts(series, depth), 8).servingFraction;
      expect(serving).toBeLessThanOrEqual(previous + 1e-9);
      previous = serving;
    }
  });

  test("the ceiling is what migration could reach, and it is never below the placement", () => {
    // Two numbers on purpose: the gap between them is what a hand-off mechanism
    // is bought for, so a ceiling below the placement would mean the model has
    // inverted its own definitions.
    const series = seriesOf(membersOf({ total: 4, planes: 1, phasing: 0, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    const hosts = selectHosts(series, 2);
    const report = capacityReport(series, hosts, 8);
    expect(report.ceilingFraction).toBeGreaterThanOrEqual(report.servingFraction);
    expect(jointLitFraction(series, hosts)).toBeCloseTo(report.servingFraction, 9);
  });

  test("picking hosts is deterministic, and the sunniest satellite alone is not the answer", () => {
    const series = seriesOf(membersOf({ total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    const first = selectHosts(series, 4);
    expect(selectHosts(series, 4)).toEqual(first);
    // The greedy start is the sunniest member, but the second pick is chosen for
    // how little its outages overlap — which is the whole content of the result.
    const sunniest = series.litFraction.indexOf(Math.max(...series.litFraction));
    expect(first[0]).toBe(sunniest);
    expect(new Set(first).size).toBe(4);
  });

  test("an empty pool and a zero budget are answered, not divided by", () => {
    const series = seriesOf(membersOf({ total: 4, planes: 2, phasing: 0, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    expect(selectHosts(series, 0)).toEqual([]);
    const report = capacityReport(series, [], 8);
    expect(report.servingFraction).toBe(0);
    expect(report.gpuHours).toBe(0);
  });
});

// The capacity model: a pipeline only runs while every stage has power, so the
// question is never "how sunny is the fleet" but "how often is every stage lit at
// once". These pin the two things that makes surprising — that plane diversity,
// not illumination, is what buys availability; and that the always-sunlit band
// really is always sunlit.
import { describe, expect, test } from "vitest";

import type { OrbitPhase } from "./clusterRange";
import { capacityReport, fleetUtilization, jointLitFraction, powerSeries, selectHosts, selectHostsRandom, selectHostsSunniest } from "./computeCapacity";
import { sunSyncWalkerParams, type SsoPlane } from "./sunSynchronous";
import { walkerDeltaRecords, WALKER_EPOCH_ISO, type WalkerDeltaParams } from "./walkerDelta";

const EPOCH = new Date(WALKER_EPOCH_ISO);

/** A pattern's satellites, as the closed form wants them. */
function membersOf(params: WalkerDeltaParams): OrbitPhase[] {
  return walkerDeltaRecords(params, EPOCH).flatMap((record) =>
    record.kind === "omm"
      ? [{ altitudeKm: params.altitudeKm, inclinationDeg: params.inclinationDeg, nodeDeg: Number(record.omm.RA_OF_ASC_NODE), phaseDeg: Number(record.omm.MEAN_ANOMALY) }]
      : [],
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

  test("the sunniest satellites are not the steadiest set", () => {
    // The baseline the paper ablates: maximise each host's own illumination. It
    // ignores correlation, and correlation is the phenomenon — so it lands below
    // the joint selection on the pool where the choice is hard (one plane's
    // worth of diversity).
    const series = seriesOf(membersOf({ total: 24, planes: 2, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    const sunniest = selectHostsSunniest(series, 4);
    const greedy = selectHosts(series, 4);
    expect(sunniest).toHaveLength(4);
    expect(jointLitFraction(series, greedy)).toBeGreaterThanOrEqual(jointLitFraction(series, sunniest));
    // And the sunniest set really is the sunniest: it is the top four by fraction.
    const ranked = [...series.litFraction].toSorted((a, b) => b - a);
    expect(sunniest.map((at) => series.litFraction[at])).toEqual(ranked.slice(0, 4));
  });

  test("random placement is deterministic, and different seeds give different answers", () => {
    const series = seriesOf(membersOf({ total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    expect(selectHostsRandom(series, 4, 7)).toEqual(selectHostsRandom(series, 4, 7));
    expect(selectHostsRandom(series, 4, 7)).not.toEqual(selectHostsRandom(series, 4, 8));
    // A permutation of the pool, not a sample with replacement.
    expect(new Set(selectHostsRandom(series, 6, 3)).size).toBe(6);
  });

  test("fleet utilisation is delivered against every GPU the fleet flies", () => {
    const series = seriesOf(membersOf({ total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }));
    const report = capacityReport(series, selectHosts(series, 4), 8);
    // 4 hosts x 8 GPUs, over 24 h, against 24 satellites x 8 GPUs x 24 h.
    expect(fleetUtilization(report, 24, 8, 24)).toBeCloseTo((4 * 8 * report.servingFraction * 24) / (24 * 8 * 24), 9);
    expect(fleetUtilization(report, 0, 8, 24)).toBe(0);
  });

  test("a shallower window is not a different answer: step size does not move the serving fraction", () => {
    // The 60 s step is a tenth of the shortest eclipse; halving it must not move
    // the number, or every table in the paper is a sampling artefact.
    const params = { total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
    const members = membersOf(params);
    const coarse = powerSeries(members, { start: EPOCH, hours: 24, stepSeconds: 60 });
    const fine = powerSeries(members, { start: EPOCH, hours: 24, stepSeconds: 30 });
    const hosts = selectHosts(coarse, 4);
    expect(capacityReport(fine, hosts, 8).servingFraction).toBeCloseTo(capacityReport(coarse, hosts, 8).servingFraction, 1);
  });
});

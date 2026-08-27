import { describe, expect, it } from "vitest";

import { orbitEnergyProfile } from "./energyStatistics";
import { darkIntervals, fullyLitFraction, optimalPipelineDepth, SLOT_SECONDS } from "./energyTrace";
import { createSatrec } from "./gp";
import { representativeAlwaysSunlitAltitudeKm, sunSyncWalkerParams } from "./sunSynchronous";
import { WALKER_EPOCH_ISO, walkerDeltaRecords, type WalkerDeltaParams } from "./walkerDelta";

const EPOCH = new Date(WALKER_EPOCH_ISO);
const shell: WalkerDeltaParams = { total: 22, planes: 1, phasing: 0, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };

function satrec(index = 0) {
  return createSatrec(walkerDeltaRecords(shell, EPOCH)[index]!);
}

describe("darkIntervals", () => {
  // Three orbits, so at least two intervals are whole.
  const intervals = darkIntervals(satrec(), EPOCH, 3 * 5742, "zenith");

  it("finds one interval per orbit", () => {
    expect(intervals.length).toBeGreaterThanOrEqual(3);
    expect(intervals.length).toBeLessThanOrEqual(4);
  });

  it("gives each interval a duration that matches its endpoints", () => {
    for (const interval of intervals) {
      expect(interval.seconds).toBeCloseTo((interval.endMs - interval.startMs) / 1000, 6);
      expect(interval.seconds).toBeGreaterThan(0);
    }
  });

  it("agrees with the aggregate profile on the longest run", () => {
    const profile = orbitEnergyProfile(satrec(), EPOCH, "zenith");
    const longest = Math.max(...intervals.filter((interval) => !interval.truncated).map((interval) => interval.seconds));
    // Same states, same step, so the longest whole interval is the profile's figure.
    expect(longest).toBeCloseTo(profile.longestDarkSeconds, 6);
  });

  it("reports the warning each interval had, as the whole lit stretch", () => {
    // Not one slot: the lead is the time the host had power, so on a ~5742 s orbit that
    // is dark for ~45 min it has to be the remaining ~50 min. Measuring from the
    // previous slot instead gave a flat 10 s and published a churn table saying so.
    for (const interval of intervals.slice(1)) {
      expect(interval.leadSeconds).toBeGreaterThan(1500);
      expect(interval.leadSeconds).toBeLessThan(5742);
      // And the two have to tile the orbit.
      expect(interval.leadSeconds + interval.seconds).toBeGreaterThan(5000);
      expect(interval.leadSeconds + interval.seconds).toBeLessThan(6000);
    }
  });

  it("marks an interval that outlives the window rather than dropping it", () => {
    // A window that ends mid-eclipse: the interval has to come back marked.
    const long = darkIntervals(satrec(), EPOCH, 3 * 5742, "zenith");
    const start = new Date(long[0]!.startMs + 60_000);
    const clipped = darkIntervals(satrec(), start, 120, "zenith");
    expect(clipped).toHaveLength(1);
    expect(clipped[0]!.truncated).toBe(true);
  });

  it("names the cause, and the panel is a cause in its own right", () => {
    const causes = new Set(intervals.map((interval) => interval.cause));
    // Under a zenith panel the panel turns away before the Earth intervenes, so the
    // intervals open for the panel's reason.
    expect(causes.has("panel")).toBe(true);
  });

  it("returns nothing for an orbit that never goes dark", () => {
    const params = sunSyncWalkerParams({ altitudeKm: representativeAlwaysSunlitAltitudeKm()!, total: 1, plane: "dawn-dusk" }, EPOCH)!;
    const sunlit = createSatrec(walkerDeltaRecords(params, EPOCH)[0]!);
    expect(darkIntervals(sunlit, EPOCH, 2 * 6000, "normal")).toEqual([]);
  });

  it("spaces the intervals of neighbouring satellites by the ring's hop time", () => {
    // 22 satellites round one plane: consecutive slots enter eclipse T/22 apart, which
    // is the 260 s hand-over period the migration model plans against.
    const first = darkIntervals(satrec(0), EPOCH, 2 * 5742, "zenith")[0]!;
    const second = darkIntervals(satrec(1), EPOCH, 2 * 5742, "zenith")[0]!;
    const apartSeconds = Math.abs(second.startMs - first.startMs) / 1000;
    expect(apartSeconds).toBeGreaterThan(200);
    expect(apartSeconds).toBeLessThan(320);
  });

  it("uses the model's slot length by default", () => {
    expect(SLOT_SECONDS).toBe(10);
    for (const interval of intervals) {
      expect(interval.seconds % SLOT_SECONDS).toBeCloseTo(0, 6);
    }
  });
});

describe("optimalPipelineDepth", () => {
  it("reproduces the model's figure for the shell average", () => {
    // N=22, f_ecl=0.34 → 14, which is the number the migration model quotes.
    expect(optimalPipelineDepth(22, 0.34)).toBe(14);
  });

  it("is the whole ring when nothing is ever eclipsed", () => {
    expect(optimalPipelineDepth(22, 0)).toBe(22);
  });

  it("collapses as the eclipse fraction rises", () => {
    expect(optimalPipelineDepth(22, 0.375)).toBe(13);
    expect(optimalPipelineDepth(22, 0.9)).toBe(2);
  });
});

describe("fullyLitFraction", () => {
  it("reproduces the model's numbers at N=22, f=0.34", () => {
    expect(fullyLitFraction(22, 0.34, 4)).toBeCloseTo(0.523, 2);
    expect(fullyLitFraction(22, 0.34, 8)).toBeCloseTo(0.342, 2);
    expect(fullyLitFraction(22, 0.34, 14)).toBeCloseTo(0.069, 2);
  });

  it("is zero once the pipeline outgrows the lit arc — the cliff", () => {
    expect(fullyLitFraction(22, 0.34, 16)).toBe(0);
    expect(fullyLitFraction(22, 0.34, 22)).toBe(0);
  });

  it("hits one for a single stage on a never-eclipsed plane", () => {
    expect(fullyLitFraction(22, 0, 1)).toBe(1);
  });

  it("is where optimalPipelineDepth stops being positive", () => {
    for (const fraction of [0, 0.1, 0.28, 0.34, 0.375]) {
      const depth = optimalPipelineDepth(22, fraction);
      expect(fullyLitFraction(22, fraction, depth)).toBeGreaterThanOrEqual(0);
      expect(fullyLitFraction(22, fraction, depth + 2)).toBe(0);
    }
  });
});

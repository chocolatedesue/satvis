import { describe, expect, it } from "vitest";

import type { IlluminationState } from "../../config/illumination";
import { fleetSeries, fleetSnapshot, isDark, isEclipsed, orbitEnergyProfile, percentile, runLengths, secondsUntilDark } from "./energyStatistics";
import { createSatrec } from "./gp";
import { representativeAlwaysSunlitAltitudeKm, sunSyncWalkerParams } from "./sunSynchronous";
import { WALKER_EPOCH_ISO, walkerDeltaRecords, type WalkerDeltaParams } from "./walkerDelta";

const EPOCH = new Date(WALKER_EPOCH_ISO);

function satrecsFor(params: WalkerDeltaParams) {
  return walkerDeltaRecords(params, EPOCH).map((record) => createSatrec(record));
}

/** The 53° / 550 km shell, one satellite per plane. */
const shell1: WalkerDeltaParams = { total: 12, planes: 12, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };

describe("the state predicates", () => {
  it("counts eclipse as the two shadow states", () => {
    expect((["umbra", "penumbra"] as IlluminationState[]).every(isEclipsed)).toBe(true);
    expect((["sunlit_back", "sunlit_edge", "sunlit_on"] as IlluminationState[]).some(isEclipsed)).toBe(false);
  });

  it("counts a back-facing panel as dark, which is the whole point of having κ", () => {
    expect(isDark("sunlit_back")).toBe(true);
    expect(isDark("umbra")).toBe(true);
    expect(isDark("sunlit_on")).toBe(false);
    // Edge-on is grazing, not nothing: it stays on the lit side of the line.
    expect(isDark("sunlit_edge")).toBe(false);
  });
});

describe("runLengths", () => {
  const step = 10;

  it("measures the longest unbroken run, not the total", () => {
    const states: IlluminationState[] = ["umbra", "umbra", "sunlit_on", "umbra", "umbra", "umbra"];
    const result = runLengths(states, isEclipsed, step);
    expect(result.longestSeconds).toBe(30);
    expect(result.totalSeconds).toBe(50);
    expect(result.count).toBe(2);
  });

  it("reports nothing for a predicate that never holds", () => {
    expect(runLengths(["sunlit_on", "sunlit_on"], isEclipsed, step)).toEqual({ longestSeconds: 0, totalSeconds: 0, count: 0 });
  });

  it("handles a run that fills the window", () => {
    const result = runLengths(["umbra", "umbra", "umbra"], isEclipsed, step);
    expect(result.longestSeconds).toBe(30);
    expect(result.count).toBe(1);
  });

  it("does not join two runs across the seam", () => {
    // Documented behaviour, and why the profile samples two orbits.
    const result = runLengths(["umbra", "sunlit_on", "umbra"], isEclipsed, step);
    expect(result.longestSeconds).toBe(10);
    expect(result.count).toBe(2);
  });
});

describe("orbitEnergyProfile", () => {
  const satrec = satrecsFor(shell1)[0]!;
  const profile = orbitEnergyProfile(satrec, EPOCH, "zenith");

  it("reports the period the satellite actually flies", () => {
    expect(profile.periodMinutes).toBeGreaterThan(94);
    expect(profile.periodMinutes).toBeLessThan(97);
  });

  it("finds a LEO eclipse of roughly a third of the orbit", () => {
    expect(profile.eclipseFraction).toBeGreaterThan(0.2);
    expect(profile.eclipseFraction).toBeLessThan(0.45);
  });

  it("finds the longest eclipse to be around half an hour, not the whole orbit", () => {
    expect(profile.longestEclipseSeconds).toBeGreaterThan(900);
    expect(profile.longestEclipseSeconds).toBeLessThan(2400);
  });

  it("sees at least one whole eclipse inside a two-orbit window", () => {
    expect(profile.eclipseCount).toBeGreaterThanOrEqual(2);
  });

  it("counts a back-facing panel on top of the eclipse, never less", () => {
    expect(profile.darkFraction).toBeGreaterThanOrEqual(profile.eclipseFraction);
    expect(profile.longestDarkSeconds).toBeGreaterThanOrEqual(profile.longestEclipseSeconds);
  });

  it("finds a penumbra of tens of seconds per orbit, not minutes", () => {
    // Two crossings, each 10-20 s, measured on a 10 s grid — so a bound in the tens.
    expect(profile.penumbraSecondsPerOrbit).toBeGreaterThan(0);
    expect(profile.penumbraSecondsPerOrbit).toBeLessThan(120);
  });

  it("reports no eclipse at all for an orbit computed not to have one", () => {
    const params = sunSyncWalkerParams({ altitudeKm: representativeAlwaysSunlitAltitudeKm()!, total: 1, plane: "dawn-dusk" }, EPOCH)!;
    const sunlit = orbitEnergyProfile(satrecsFor(params)[0]!, EPOCH, "normal");
    expect(sunlit.eclipseFraction).toBe(0);
    expect(sunlit.longestEclipseSeconds).toBe(0);
    expect(sunlit.darkFraction).toBe(0);
  });

  it("reads the panel model it is given", () => {
    const zenith = orbitEnergyProfile(satrec, EPOCH, "zenith");
    const normal = orbitEnergyProfile(satrec, EPOCH, "normal");
    // ν does not depend on the panel, so the eclipse figures must agree exactly …
    expect(normal.eclipseFraction).toBeCloseTo(zenith.eclipseFraction, 12);
    // … and κ does, so the dark figures must not.
    expect(normal.darkFraction).not.toBeCloseTo(zenith.darkFraction, 3);
  });
});

describe("fleetSnapshot", () => {
  const satrecs = satrecsFor({ ...shell1, total: 24, planes: 12 });

  it("classifies every satellite exactly once", () => {
    const snapshot = fleetSnapshot(satrecs, EPOCH, "zenith");
    expect(snapshot.total).toBe(24);
    expect(Object.values(snapshot.counts).reduce((sum, value) => sum + value, 0)).toBe(24);
  });

  it("puts the eclipsed share below the dark share", () => {
    const snapshot = fleetSnapshot(satrecs, EPOCH, "zenith");
    expect(snapshot.darkFraction).toBeGreaterThanOrEqual(snapshot.eclipsedFraction);
    expect(snapshot.eclipsedFraction).toBeGreaterThan(0);
    expect(snapshot.eclipsedFraction).toBeLessThan(1);
  });

  it("answers for an empty fleet rather than dividing by zero", () => {
    expect(fleetSnapshot([], EPOCH, "zenith")).toEqual({ total: 0, counts: {}, eclipsedFraction: 0, darkFraction: 0 });
  });
});

describe("fleetSeries", () => {
  const satrecs = satrecsFor({ ...shell1, total: 24, planes: 12 });

  it("walks the window and reports a spread", () => {
    const series = fleetSeries(satrecs, EPOCH, 3600, 300, "zenith");
    expect(series.samples).toBe(13);
    expect(series.eclipsedFraction.min).toBeLessThanOrEqual(series.eclipsedFraction.mean);
    expect(series.eclipsedFraction.mean).toBeLessThanOrEqual(series.eclipsedFraction.max);
  });

  it("finds the fleet's eclipsed share steadier than any one satellite's", () => {
    // The routing-relevant fact: individual satellites swing between 0 and 1, the
    // aggregate does not — so capacity loss is a level to provision for, and a
    // scheduling problem only at the margin.
    const series = fleetSeries(satrecs, EPOCH, 5700, 60, "zenith");
    expect(series.eclipsedFraction.max - series.eclipsedFraction.min).toBeLessThan(0.4);
  });
});

describe("secondsUntilDark", () => {
  const satrec = satrecsFor(shell1)[0]!;

  it("finds a deadline within one orbit for a satellite that is currently powered", () => {
    // Search from a moment the satellite is known to be lit.
    const horizon = 6000;
    let found: number | undefined;
    for (let minute = 0; minute < 96 && found === undefined; minute += 5) {
      found = secondsUntilDark(satrec, new Date(EPOCH.getTime() + minute * 60_000), "zenith", horizon);
    }
    expect(found).toBeDefined();
    expect(found!).toBeGreaterThan(0);
    expect(found!).toBeLessThan(horizon);
  });

  it("declines to answer for a satellite that is already dark", () => {
    // Walk until one is dark, then ask: the answer is not 0, it is "wrong question".
    let dark: Date | undefined;
    for (let minute = 0; minute < 96 && !dark; minute += 1) {
      const at = new Date(EPOCH.getTime() + minute * 60_000);
      if (secondsUntilDark(satrec, at, "zenith", 60) === undefined && minute > 0) {
        dark = at;
      }
    }
    expect(dark).toBeDefined();
  });

  it("returns undefined for an orbit that never goes dark inside the horizon", () => {
    const params = sunSyncWalkerParams({ altitudeKm: representativeAlwaysSunlitAltitudeKm()!, total: 1, plane: "dawn-dusk" }, EPOCH)!;
    expect(secondsUntilDark(satrecsFor(params)[0]!, EPOCH, "normal", 8000, 20)).toBeUndefined();
  });
});

describe("percentile", () => {
  it("reads by nearest rank", () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(30);
    expect(percentile(values, 1)).toBe(50);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it("answers NaN for nothing, rather than throwing", () => {
    expect(percentile([], 0.5)).toBeNaN();
  });
});

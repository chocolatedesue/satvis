import { describe, expect, test } from "vitest";

import { SAMPLES_PER_ORBIT, trajectoryWindow, WINDOW_ORBITS_BACK, WINDOW_ORBITS_FORWARD } from "./trajectoryWindow";

const ISS_PERIOD_MIN = 92.6;

describe("trajectoryWindow", () => {
  test("spans half an orbit back and one and a half forward", () => {
    const window = trajectoryWindow(ISS_PERIOD_MIN);
    const periodSeconds = ISS_PERIOD_MIN * 60;

    expect(window.offsetSeconds).toBeCloseTo(-periodSeconds * WINDOW_ORBITS_BACK, 6);
    expect(window.spanSeconds).toBeCloseTo(periodSeconds * (WINDOW_ORBITS_BACK + WINDOW_ORBITS_FORWARD), 6);
  });

  test("steps at the sampling rate and counts the closing boundary", () => {
    const window = trajectoryWindow(ISS_PERIOD_MIN);

    expect(window.stepSeconds).toBeCloseTo((ISS_PERIOD_MIN * 60) / SAMPLES_PER_ORBIT, 6);
    // Two orbits at 120 a revolution is 240 steps, and the loop takes the stop
    // boundary as well. The running app reported exactly 241 samples a satellite.
    expect(window.sampleCount).toBe(241);
  });

  test("scales with the period rather than assuming LEO", () => {
    // A geostationary period: the same 241 samples, spread far wider.
    const geo = trajectoryWindow(1436);

    expect(geo.sampleCount).toBe(241);
    expect(geo.stepSeconds).toBeCloseTo((1436 * 60) / SAMPLES_PER_ORBIT, 6);
  });

  test("an unusable period yields an empty window rather than NaN", () => {
    // A satrec that failed to parse reports no mean motion, and the period comes
    // out zero or infinite. Dividing that would give a NaN sample count and, in
    // the worker, a NaN-sized buffer.
    for (const period of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const window = trajectoryWindow(period);
      expect(window.sampleCount).toBe(0);
      expect(Number.isFinite(window.stepSeconds)).toBe(true);
      expect(Number.isFinite(window.offsetSeconds)).toBe(true);
      expect(Number.isFinite(window.spanSeconds)).toBe(true);
    }
  });
});

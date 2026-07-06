import { JulianDate } from "@cesium/engine";
import dayjs from "dayjs";
import { describe, expect, test, vi } from "vitest";

import Orbit from "./Orbit";
import { PassPredictor, filterPasses, formatCountdown, stationPasses, toPassRows, type GroundStation, type Pass } from "./PassPredictor";
import { parseGpPayload, type GpRecord } from "./util/gp";

const T0 = Date.UTC(2026, 6, 1, 12, 0, 0); // 2026-07-01T12:00:00Z
const NOW = JulianDate.fromDate(new Date(T0));

function elevationPass(startOffsetMs: number, endOffsetMs: number, groundStationName = "Munich"): Pass {
  return {
    name: "ISS",
    start: T0 + startOffsetMs,
    end: T0 + endOffsetMs,
    duration: endOffsetMs - startOffsetMs,
    azimuthStart: 10,
    azimuthApex: 123.456,
    azimuthEnd: 200,
    maxElevation: 56.7,
    groundStationName,
  };
}

function swathPass(startOffsetMs: number, endOffsetMs: number): Pass {
  return {
    name: "ISS",
    start: T0 + startOffsetMs,
    end: T0 + endOffsetMs,
    duration: endOffsetMs - startOffsetMs,
    minDistance: 12.34,
    minDistanceTime: T0 + startOffsetMs,
    swathWidth: 1234.5,
    groundStationName: "Munich",
  };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

// Time near the TLE epoch so SGP4 propagation stays meaningful.
const EPOCH_TIME = JulianDate.fromDate(dayjs("2018-12-08").toDate());

const MUNICH: GroundStation = { name: "Munich", position: { latitude: 48.177, longitude: 11.7476, height: 0 } };
const VIENNA: GroundStation = { name: "Vienna", position: { latitude: 48.2082, longitude: 16.3738, height: 0 } };

function issPredictor(swathKm = 500): { orbit: Orbit; predictor: PassPredictor } {
  const orbit = new Orbit("ISS", parseGpPayload(TLE)[0] as GpRecord);
  const predictor = new PassPredictor(orbit, () => swathKm);
  return { orbit, predictor };
}

describe("PassPredictor", () => {
  test("returns no passes without a ground station", () => {
    const { orbit, predictor } = issPredictor();
    const spy = vi.spyOn(orbit, "computePassesElevation");
    expect(predictor.passes(EPOCH_TIME)).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  test("computes passes with the station name attached and intervals in sync", () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    const passes = predictor.passes(EPOCH_TIME);
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every((pass) => pass.groundStationName === "Munich")).toBe(true);
    expect(predictor.passIntervals.length).toBe(passes.length);
  });

  test("recomputes only when time leaves the pass window", () => {
    const { orbit, predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    const spy = vi.spyOn(orbit, "computePassesElevation");

    predictor.passes(EPOCH_TIME);
    expect(spy).toHaveBeenCalledTimes(1);

    // Inside the ±1 day window: no recompute.
    predictor.passes(JulianDate.addSeconds(EPOCH_TIME, 3600, new JulianDate()));
    expect(spy).toHaveBeenCalledTimes(1);

    // A jump beyond the window forces a recompute.
    predictor.passes(JulianDate.addDays(EPOCH_TIME, 2, new JulianDate()));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("changing ground stations clears the computed passes", () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    expect(predictor.passes(EPOCH_TIME).length).toBeGreaterThan(0);

    predictor.groundStations = [];
    expect(predictor.passes(EPOCH_TIME)).toHaveLength(0);
    expect(predictor.passIntervals.length).toBe(0);
  });

  test("swath mode computes swath passes using the resolved swath width", () => {
    const { orbit, predictor } = issPredictor(290);
    predictor.groundStations = [MUNICH];
    const spy = vi.spyOn(orbit, "computePassesSwath");

    predictor.mode = "swath";
    const passes = predictor.passes(EPOCH_TIME);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(290);
    expect(passes.every((pass) => "minDistance" in pass)).toBe(true);
  });

  test("setting the same mode keeps the window intact", () => {
    const { orbit, predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    predictor.passes(EPOCH_TIME);
    const spy = vi.spyOn(orbit, "computePassesElevation");

    predictor.mode = "elevation";
    predictor.passes(EPOCH_TIME);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("stationPasses", () => {
  test("keeps only the named station's passes, sorted by start", () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH, VIENNA];
    const all = predictor.passes(EPOCH_TIME);
    expect(all.some((pass) => pass.groundStationName === "Vienna")).toBe(true);

    const munich = stationPasses([predictor], EPOCH_TIME, "Munich");
    expect(munich.length).toBeGreaterThan(0);
    expect(munich.every((pass) => pass.groundStationName === "Munich")).toBe(true);
    expect(munich).toEqual(munich.toSorted((a, b) => a.start - b.start));
  });

  test("drops passes starting beyond the deltaHours horizon", () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    const horizon = stationPasses([predictor], EPOCH_TIME, "Munich", 1);
    const startLimit = JulianDate.toDate(EPOCH_TIME).getTime() + 2 * HOUR;
    expect(horizon.every((pass) => pass.start < startLimit)).toBe(true);
  });
});

describe("filterPasses", () => {
  test("drops passes that have already ended", () => {
    const passes = [elevationPass(-2 * HOUR, -1 * HOUR), elevationPass(-5 * MIN, 5 * MIN), elevationPass(1 * HOUR, 2 * HOUR)];
    const upcoming = filterPasses(passes, NOW, false);
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0]!.start).toBe(T0 - 5 * MIN);
  });

  test("drops an ended pass interleaved after an ongoing one", () => {
    // Aggregated ground-station lists are sorted by start, so a finished pass
    // of one satellite can follow the ongoing pass of another.
    const passes = [elevationPass(-2 * HOUR, 5 * MIN), elevationPass(-90 * MIN, -1 * HOUR), elevationPass(1 * HOUR, 2 * HOUR)];
    const upcoming = filterPasses(passes, NOW, false);
    expect(upcoming).toHaveLength(2);
    expect(upcoming.every((pass) => pass.end > T0)).toBe(true);
  });

  test("returns empty array when all passes are over", () => {
    const passes = [elevationPass(-2 * HOUR, -1 * HOUR)];
    expect(filterPasses(passes, NOW, false)).toHaveLength(0);
  });

  test("keeps every pass when past passes are shown", () => {
    const passes = [elevationPass(-2 * HOUR, -1 * HOUR), elevationPass(-5 * MIN, 5 * MIN), elevationPass(1 * HOUR, 2 * HOUR)];
    expect(filterPasses(passes, NOW, true)).toHaveLength(3);
  });
});

describe("formatCountdown", () => {
  test("ongoing pass", () => {
    expect(formatCountdown(NOW, elevationPass(-5 * MIN, 5 * MIN))).toBe("ONGOING");
  });

  test("previous pass", () => {
    expect(formatCountdown(NOW, elevationPass(-2 * HOUR, -1 * HOUR))).toBe("PREVIOUS");
  });

  test("future pass renders zero-padded DD:HH:MM:SS", () => {
    const pass = elevationPass(1 * DAY + 2 * HOUR + 3 * MIN + 4 * 1000, 2 * DAY);
    expect(formatCountdown(NOW, pass)).toBe("01:02:03:04");
  });
});

describe("toPassRows", () => {
  test("elevation mode uses maxElevation/azimuthApex and the given name field", () => {
    const [row] = toPassRows([elevationPass(1 * HOUR, 1 * HOUR + 10 * MIN)], NOW, "groundStationName", "elevation");
    expect(row!.name).toBe("Munich");
    expect(row!.primary).toBe("57°");
    expect(row!.secondary).toBe("123.46°");
    expect(row!.startLabel).toBe("01.07 13:00:00");
    expect(row!.endLabel).toBe("13:10:00");
    expect(row!.startMs).toBe(T0 + 1 * HOUR);
  });

  test("swath mode uses minDistance/swathWidth", () => {
    const [row] = toPassRows([swathPass(1 * HOUR, 1 * HOUR + 10 * MIN)], NOW, "name", "swath");
    expect(row!.name).toBe("ISS");
    expect(row!.primary).toBe("12.3km");
    expect(row!.secondary).toBe("1235km");
  });

  test("elevation pass in swath mode falls back to elevation columns", () => {
    const [row] = toPassRows([elevationPass(1 * HOUR, 2 * HOUR)], NOW, "name", "swath");
    expect(row!.primary).toBe("57°");
    expect(row!.secondary).toBe("123.46°");
  });
});

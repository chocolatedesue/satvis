import { JulianDate } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import type { Pass } from "../modules/SatelliteProperties";
import { formatCountdown, formatEpoch, toPassRows, upcomingPasses } from "../modules/util/entityInfo";

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

describe("upcomingPasses", () => {
  test("drops passes that have already ended", () => {
    const passes = [elevationPass(-2 * HOUR, -1 * HOUR), elevationPass(-5 * MIN, 5 * MIN), elevationPass(1 * HOUR, 2 * HOUR)];
    const upcoming = upcomingPasses(passes, NOW);
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0]!.start).toBe(T0 - 5 * MIN);
  });

  test("returns empty array when all passes are over", () => {
    const passes = [elevationPass(-2 * HOUR, -1 * HOUR)];
    expect(upcomingPasses(passes, NOW)).toHaveLength(0);
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

describe("formatEpoch", () => {
  test("formats a julian date as UTC timestamp", () => {
    // JD 2460000.5 == 2023-02-25T00:00:00Z
    expect(formatEpoch(2460000.5)).toBe("2023-02-25 00:00:00");
  });
});

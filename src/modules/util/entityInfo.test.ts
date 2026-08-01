import { describe, expect, test } from "vitest";

import { formatEpoch, getSatelliteInfo } from "./entityInfo";

function labels(rows: [string, string][]): string[] {
  return rows.map(([label]) => label);
}

function valueOf(rows: [string, string][], label: string): string | undefined {
  return rows.find(([rowLabel]) => rowLabel === label)?.[1];
}

describe("formatEpoch", () => {
  test("formats a julian date as UTC timestamp", () => {
    // JD 2460000.5 == 2023-02-25T00:00:00Z
    expect(formatEpoch(2460000.5)).toBe("2023-02-25 00:00:00");
  });
});

describe("getSatelliteInfo", () => {
  test("always reports the derived orbit class, even with no metadata", () => {
    expect(getSatelliteInfo("LEO", {})).toEqual([["Orbit", "LEO"]]);
  });

  test("omits every row the record does not carry, rather than showing defaults", () => {
    // A satellite absent from the satellite table still renders with a 200 km
    // swath and a 10° cone; showing those here would present a renderer fallback
    // as a fact about the satellite.
    expect(labels(getSatelliteInfo("LEO", {}))).not.toContain("Swath");
    expect(labels(getSatelliteInfo("LEO", {}))).not.toContain("Sensor FOV");
  });

  test("shows a symmetric swath as a single total", () => {
    const rows = getSatelliteInfo("LEO", { swathStarboardKm: 1175, swathPortKm: 1175 });
    expect(valueOf(rows, "Swath")).toBe("2350 km");
  });

  test("spells out the sides when they differ", () => {
    const rows = getSatelliteInfo("LEO", { swathStarboardKm: 1000, swathPortKm: 500 });
    expect(valueOf(rows, "Swath")).toBe("1500 km (1000 stbd / 500 port)");
  });

  test("includes the display-only fields when present", () => {
    const rows = getSatelliteInfo("LEO", { coneFovDeg: 45, operator: "ESA", missionType: "Earth observation" });
    expect(valueOf(rows, "Sensor FOV")).toBe("45°");
    expect(valueOf(rows, "Operator")).toBe("ESA");
    expect(valueOf(rows, "Mission")).toBe("Earth observation");
  });
});

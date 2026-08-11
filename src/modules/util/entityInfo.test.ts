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

  describe("SATCAT fields", () => {
    test("resolves owner, launch and status codes to labels", () => {
      const rows = getSatelliteInfo("LEO", { owner: "ISS", launchDate: "1998-11-20", launchSite: "TYMSC", opsStatus: "+" });
      expect(valueOf(rows, "Owner")).toBe("International Space Station");
      expect(valueOf(rows, "Launched")).toBe("1998-11-20 · Baikonur, Kazakhstan");
      expect(valueOf(rows, "Status")).toBe("Operational");
    });

    test("falls back to the raw code for one it does not know", () => {
      // These tables go stale by design — a new nation reaches orbit and the
      // record arrives before the table knows about it. A code beats a blank.
      const rows = getSatelliteInfo("LEO", { owner: "ZZZ", launchDate: "2026-01-01", launchSite: "QQQ", opsStatus: "!" });
      expect(valueOf(rows, "Owner")).toBe("ZZZ");
      expect(valueOf(rows, "Launched")).toBe("2026-01-01 · QQQ");
      expect(valueOf(rows, "Status")).toBe("!");
    });

    test("shows the launch date alone when the site is missing", () => {
      expect(valueOf(getSatelliteInfo("LEO", { launchDate: "1998-11-20" }), "Launched")).toBe("1998-11-20");
    });

    test("suppresses the ordinary orbit type but names the interesting ones", () => {
      // "Orbiting" is true of all but a handful of the satellites served, so it
      // would cost a row on every panel to say nothing.
      expect(labels(getSatelliteInfo("LEO", { orbitType: "ORB" }))).not.toContain("Orbit type");
      expect(valueOf(getSatelliteInfo("LEO", { orbitType: "DOC" }), "Orbit type")).toBe("Docked");
      expect(valueOf(getSatelliteInfo("LEO", { orbitType: "IMP" }), "Orbit type")).toBe("Impacted");
    });

    test("reports a decay date only once there is one", () => {
      expect(labels(getSatelliteInfo("LEO", { opsStatus: "+" }))).not.toContain("Decayed");
      expect(valueOf(getSatelliteInfo("LEO", { decayDate: "2026-08-03" }), "Decayed")).toBe("2026-08-03");
    });

    test("adds nothing for a satellite the catalog said nothing about", () => {
      expect(getSatelliteInfo("MEO", {})).toEqual([["Orbit", "MEO"]]);
    });
  });
});

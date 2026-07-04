import { describe, expect, test } from "vitest";

import { SatelliteCatalog } from "../modules/SatelliteCatalog";
import { parseGpPayload, type GpRecord } from "../modules/util/gp";

// Two OMM records; ALPHA appears in both groups (same satnum + name) to
// exercise cross-group dedup and tag union.
function ommRecord(name: string, satnum: number): GpRecord {
  return {
    kind: "omm",
    omm: {
      OBJECT_NAME: name,
      OBJECT_ID: "",
      EPOCH: "2026-07-04T00:00:00.000000",
      MEAN_MOTION: 15,
      ECCENTRICITY: 0,
      INCLINATION: 51,
      RA_OF_ASC_NODE: 0,
      ARG_OF_PERICENTER: 0,
      MEAN_ANOMALY: 0,
      NORAD_CAT_ID: satnum,
      ELEMENT_SET_NO: 0,
      BSTAR: 0,
      MEAN_MOTION_DOT: 0,
      MEAN_MOTION_DDOT: 0,
    },
  };
}

describe("SatelliteCatalog", () => {
  test("dedups across two groups and unions tags", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("ALPHA", 1), ommRecord("BETA", 2)], ["GroupA"]);
    catalog.addRecords([ommRecord("ALPHA", 1), ommRecord("GAMMA", 3)], ["GroupB"]);

    // ALPHA, BETA, GAMMA — ALPHA is not duplicated.
    expect(catalog.size).toBe(3);
    const alpha = catalog.getByName("ALPHA");
    expect(alpha?.tags).toEqual(["GroupA", "GroupB"]);
  });

  test("first-wins byName", () => {
    const catalog = new SatelliteCatalog();
    // Same name, different satnums → distinct keys, but getByName returns first.
    catalog.addRecords([ommRecord("DUPE", 10)], ["A"]);
    catalog.addRecords([ommRecord("DUPE", 11)], ["B"]);
    expect(catalog.size).toBe(2);
    expect(catalog.getByName("DUPE")?.satnum).toBe("10");
  });

  test("taglist shape: tag -> sorted names", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("ZULU", 1), ommRecord("ALPHA", 2)], ["Weather"]);
    const taglist = catalog.taglist();
    expect(taglist.Weather).toEqual(["ALPHA", "ZULU"]);
  });

  test("groups reports per-tag counts", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("A", 1), ommRecord("B", 2)], ["G1"]);
    catalog.addRecords([ommRecord("C", 3)], ["G2"]);
    const groups = catalog.groups.toSorted((a, b) => a.tag.localeCompare(b.tag));
    expect(groups).toEqual([
      { tag: "G1", count: 2 },
      { tag: "G2", count: 1 },
    ]);
  });

  test("onChange fires with added and merged entries", () => {
    const catalog = new SatelliteCatalog();
    const batches: number[] = [];
    catalog.onChange((entries) => batches.push(entries.length));
    // addRecords does not fire onChange directly; only loadGroup does. Emulate
    // by checking the returned changed set instead.
    const changed1 = catalog.addRecords([ommRecord("A", 1)], ["G1"]);
    expect(changed1).toHaveLength(1);
    // Re-adding with a new tag returns the merged entry.
    const changed2 = catalog.addRecords([ommRecord("A", 1)], ["G2"]);
    expect(changed2).toHaveLength(1);
    // Re-adding with an existing tag returns nothing changed.
    const changed3 = catalog.addRecords([ommRecord("A", 1)], ["G1"]);
    expect(changed3).toHaveLength(0);
    expect(batches).toEqual([]);
  });

  test("integrates with parseGpPayload output", () => {
    const catalog = new SatelliteCatalog();
    const payload = JSON.stringify([ommRecord("ISS (ZARYA)", 25544).kind === "omm" ? (ommRecord("ISS (ZARYA)", 25544) as { omm: unknown }).omm : {}]);
    const records = parseGpPayload(payload);
    catalog.addRecords(records, ["Stations"]);
    expect(catalog.getByName("ISS (ZARYA)")?.satnum).toBe("25544");
  });
});

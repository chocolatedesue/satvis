import { describe, expect, test } from "vitest";

import { appMetadataConfig, type MetadataRule } from "../config/satelliteMetadata";
import { SatelliteCatalog } from "../modules/SatelliteCatalog";
import type { GpRecord } from "../modules/util/gp";

// Minimal OMM record — only name + satnum matter for metadata resolution.
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

// Build a single-entry catalog with the given name and resolve its metadata.
function metadataFor(name: string, satnum = 1) {
  const catalog = new SatelliteCatalog();
  catalog.addRecords([ommRecord(name, satnum)], ["Test"]);
  return catalog.getByName(name)!.metadata;
}

// The old hardcoded swath table (SatelliteProperties.swath before Phase 4),
// expressed as [representative name, expected swath].
const OLD_SWATH_TABLE: [string, number][] = [
  ["SUOMI NPP", 3000],
  ["NOAA 20 (JPSS-1)", 3000],
  ["NOAA 21 (JPSS-2)", 3000],
  ["AQUA", 2330],
  ["TERRA", 2330],
  ["SENTINEL-2A", 290],
  ["SENTINEL-2B", 290],
  ["SENTINEL-3A", 740],
  ["SENTINEL-3B", 740],
  ["LANDSAT 8", 185],
  ["LANDSAT 9", 185],
  ["FENGYUN 3D", 2900],
  ["METOP-B", 2900],
  ["METOP-C", 2900],
];

describe("satellite metadata resolution", () => {
  test("parity with the old hardcoded swath table", () => {
    for (const [name, expected] of OLD_SWATH_TABLE) {
      expect(metadataFor(name).swathKm, name).toBe(expected);
    }
  });

  test("default-case name returns app defaults (swath 200, cone 10)", () => {
    const md = metadataFor("SOME RANDOM SAT");
    expect(md.swathKm).toBe(200);
    expect(md.coneFovDeg).toBe(10);
  });

  test("cone FOV defaults to 10 for a swath-table satellite too", () => {
    // Rules only set swathKm; coneFovDeg comes from defaults.
    expect(metadataFor("SUOMI NPP").coneFovDeg).toBe(10);
  });

  test("substring names match via namePattern (mirrors old includes())", () => {
    // The old code used name.includes("SENTINEL-2"); the regex is the literal.
    expect(metadataFor("SENTINEL-2C").swathKm).toBe(290);
    expect(metadataFor("COPERNICUS SENTINEL-3X").swathKm).toBe(740);
  });

  test("matches by satnums (exact, against normalized satnum)", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("MYSTERY SAT", 25544)], ["Test"]);
    catalog.mergeMetadataConfig([{ match: { satnums: ["25544"] }, metadata: { swathKm: 1234 } }]);
    expect(catalog.getByName("MYSTERY SAT")!.metadata.swathKm).toBe(1234);
  });

  test("remote rule overrides app rule field-wise (keeps app coneFovDeg)", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("SUOMI NPP", 43013)], ["Weather"]);
    // App rule sets swathKm 3000; coneFovDeg comes from defaults (10).
    const entry = catalog.getByName("SUOMI NPP")!;
    expect(entry.metadata.swathKm).toBe(3000);
    expect(entry.metadata.coneFovDeg).toBe(10);

    // Remote rule sets only swathKm — coneFovDeg must remain the app default.
    catalog.mergeMetadataConfig([{ match: { names: ["SUOMI NPP"] }, metadata: { swathKm: 5000 } }]);
    expect(entry.metadata.swathKm).toBe(5000);
    expect(entry.metadata.coneFovDeg).toBe(10);
  });

  test("revision invalidation: metadata recomputes after mergeMetadataConfig", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("PLAIN SAT", 99999)], ["Test"]);
    const entry = catalog.getByName("PLAIN SAT")!;
    // Initial resolution (memoized) -> defaults.
    expect(entry.metadata.swathKm).toBe(200);
    expect(entry.metadata.modelUrl).toBeUndefined();

    catalog.mergeMetadataConfig([{ match: { names: ["PLAIN SAT"] }, metadata: { swathKm: 42, modelUrl: "custom.glb" } }]);
    // Same entry object, but the getter now reflects the new rule.
    expect(entry.metadata.swathKm).toBe(42);
    expect(entry.metadata.modelUrl).toBe("custom.glb");
  });

  test("namePattern regex is cached and repeated calls stay consistent", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("SENTINEL-2A", 40697), ommRecord("SENTINEL-2B", 42063)], ["Copernicus"]);
    const a = catalog.getByName("SENTINEL-2A")!;
    const b = catalog.getByName("SENTINEL-2B")!;
    // Multiple reads across multiple entries reuse the compiled RegExp.
    for (let i = 0; i < 3; i += 1) {
      expect(a.metadata.swathKm).toBe(290);
      expect(b.metadata.swathKm).toBe(290);
    }
  });

  test("app rules translate the full old table (config sanity)", () => {
    // Guard against accidental edits to the translated rule set.
    expect(appMetadataConfig.defaults).toEqual({ swathKm: 200, coneFovDeg: 10 });
    const rules: MetadataRule[] = appMetadataConfig.rules;
    expect(rules).toHaveLength(7);
  });
});

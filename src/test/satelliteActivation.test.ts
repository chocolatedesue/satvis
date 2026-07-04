import { describe, expect, test } from "vitest";

import { activeTargetEntries } from "../modules/satelliteActivation";
import type { CatalogEntry } from "../modules/SatelliteCatalog";
import type { GpRecord } from "../modules/util/gp";

// Minimal CatalogEntry factory — activeTargetEntries only reads key/name/tags,
// so the record is a filler value.
function entry(name: string, satnum: string, tags: string[]): CatalogEntry {
  const record: GpRecord = { kind: "tle", name, line1: "", line2: "" };
  return { key: `${satnum}|${name}`, name, nameUpper: name.toUpperCase(), satnum, tags, record };
}

const ALPHA = entry("ALPHA", "1", ["Weather", "New"]);
const BETA = entry("BETA", "2", ["Weather"]);
const GAMMA = entry("GAMMA", "3", ["Science"]);
const DELTA = entry("DELTA", "4", []);
const ALL = [ALPHA, BETA, GAMMA, DELTA];

function keys(target: Map<string, CatalogEntry>): string[] {
  return [...target.keys()].toSorted();
}

describe("activeTargetEntries", () => {
  test("empty state selects nothing", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: [], enabledSatellites: [] });
    expect(target.size).toBe(0);
  });

  test("selects by tag (OR across an entry's tags)", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: [] });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
  });

  test("selects by name", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: [], enabledSatellites: ["GAMMA", "DELTA"] });
    expect(keys(target)).toEqual([GAMMA.key, DELTA.key].toSorted());
  });

  test("unions tag and name selections", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Science"], enabledSatellites: ["ALPHA"] });
    expect(keys(target)).toEqual([ALPHA.key, GAMMA.key].toSorted());
  });

  test("dedups a satellite enabled by both tag and name", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: ["ALPHA"] });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
    expect(target.get(ALPHA.key)).toBe(ALPHA);
  });

  test("tracked satellite is kept alive even when its tag is disabled", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: [], enabledSatellites: [], trackedName: "GAMMA" });
    expect(keys(target)).toEqual([GAMMA.key]);
  });

  test("pending-tracked satellite is included", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: [], enabledSatellites: [], pendingTrackedName: "DELTA" });
    expect(keys(target)).toEqual([DELTA.key]);
  });

  test("tracked union with tag selection dedups", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: [], trackedName: "ALPHA" });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
  });
});

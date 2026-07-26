import { describe, expect, test } from "vitest";

import { activeTargetEntries, isEnabledByTag } from "./satelliteActivation";
import { CatalogEntry, SatelliteCatalog } from "./SatelliteCatalog";
import type { GpRecord } from "./util/gp";

// Minimal CatalogEntry factory — activeTargetEntries only reads key/name/tags.
// CatalogEntry needs a catalog back-reference for lazy metadata resolution, so
// build entries through a throwaway catalog rather than a plain object literal.
const catalog = new SatelliteCatalog();
function entry(name: string, satnum: string, tags: string[]): CatalogEntry {
  const record: GpRecord = { kind: "tle", name, line1: "", line2: "" };
  return new CatalogEntry(catalog, { key: `${satnum}|${name}`, name, nameUpper: name.toUpperCase(), satnum, tags, record });
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

  test("disabledSatellites opts a member out of tag activation", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: [], disabledSatellites: ["BETA"] });
    expect(keys(target)).toEqual([ALPHA.key]);
  });

  test("disabledSatellites does not beat an explicit individual enable", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: ["BETA"], disabledSatellites: ["BETA"] });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
  });

  test("disabledSatellites does not beat tracking", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: [], disabledSatellites: ["BETA"], trackedName: "BETA" });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
  });

  test("disabledSatellites without a covering tag has no effect", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Science"], enabledSatellites: [], disabledSatellites: ["ALPHA"] });
    expect(keys(target)).toEqual([GAMMA.key]);
  });
});

describe("isEnabledByTag", () => {
  test("matches when any of the entry's tags is enabled", () => {
    expect(isEnabledByTag(ALPHA, new Set(["New"]))).toBe(true);
    expect(isEnabledByTag(ALPHA, new Set(["Science", "Weather"]))).toBe(true);
  });

  test("does not match when no tag is enabled", () => {
    expect(isEnabledByTag(GAMMA, new Set(["Weather"]))).toBe(false);
    expect(isEnabledByTag(ALPHA, new Set())).toBe(false);
  });

  test("never matches an entry without tags", () => {
    expect(isEnabledByTag(DELTA, new Set(["Weather", "Science", "New"]))).toBe(false);
  });
});

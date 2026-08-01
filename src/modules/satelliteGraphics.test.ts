import { describe, expect, test } from "vitest";

import { coneDescription, groundTrackDescription, isLeo, modelUri, orbitPathTimes, orbitTrackTimes, orbitUsesPathGraphic } from "./satelliteGraphics";

const ISS_PERIOD_MIN = 92.6;

describe("isLeo", () => {
  test("gates on the orbit class itself, so it cannot disagree with the label", () => {
    expect(isLeo("LEO")).toBe(true);
    expect(isLeo("MEO")).toBe(false);
    expect(isLeo("GEO")).toBe(false);
    // A highly elliptical orbit can have a short period; a swath corridor under
    // one would be meaningless, and the class already rules it out.
    expect(isLeo("HEO")).toBe(false);
  });
});

describe("orbit path times", () => {
  test("path leads and trails half a period plus overlap", () => {
    const { leadTime, trailTime } = orbitPathTimes(ISS_PERIOD_MIN);
    expect(leadTime).toBeCloseTo((ISS_PERIOD_MIN * 60) / 2 + 5);
    expect(trailTime).toBe(leadTime);
  });

  test("track leads one full period with no trail", () => {
    expect(orbitTrackTimes(ISS_PERIOD_MIN)).toEqual({ leadTime: ISS_PERIOD_MIN * 60, trailTime: 0 });
  });
});

describe("groundTrackDescription", () => {
  test("converts the swath width to meters", () => {
    expect(groundTrackDescription("LEO", 290)).toEqual({ widthMeters: 290000 });
  });

  test("is unavailable for non-LEO satellites", () => {
    expect(groundTrackDescription("GEO", 290)).toBeUndefined();
  });
});

describe("coneDescription", () => {
  test("converts the FOV to a half angle in radians", () => {
    const description = coneDescription("LEO", 45);
    expect(description).toBeDefined();
    expect(description!.radiusMeters).toBe(1000000);
    expect(description!.innerHalfAngleRad).toBe(0);
    expect(description!.outerHalfAngleRad).toBeCloseTo(Math.PI / 4);
  });

  test("is unavailable for non-LEO satellites", () => {
    expect(coneDescription("GEO", 45)).toBeUndefined();
  });
});

describe("modelUri", () => {
  test("prefers the explicit metadata model URL", () => {
    expect(modelUri("FOREST-2", "./data/models/custom.glb")).toBe("./data/models/custom.glb");
  });

  test("falls back to the name-convention path with spaces dashed", () => {
    expect(modelUri("ISS (ZARYA)")).toBe("./data/models/ISS-(ZARYA).glb");
  });
});

describe("orbitUsesPathGraphic", () => {
  test("tracked satellites always use the path graphic", () => {
    expect(orbitUsesPathGraphic(true, true)).toBe(true);
    expect(orbitUsesPathGraphic(true, false)).toBe(true);
  });

  test("untracked satellites use the primitive only when the scene supports it", () => {
    expect(orbitUsesPathGraphic(false, true)).toBe(false);
    expect(orbitUsesPathGraphic(false, false)).toBe(true);
  });
});

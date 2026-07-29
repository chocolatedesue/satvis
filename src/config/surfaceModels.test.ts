// The suppression matrix. Everything the menu annotates and everything
// SurfaceModel executes comes from here, so this is where the rules are pinned.
import { describe, expect, test } from "vitest";

import { surfaceEffects } from "./surfaceModels";

describe("surfaceEffects", () => {
  test("None draws nothing and takes nothing away", () => {
    for (const viewMode of ["3D", "2D", "Columbus", "Sky"]) {
      expect(surfaceEffects("None", viewMode)).toMatchObject({
        tileset: undefined,
        hideGlobe: false,
        terrain: undefined,
        inert: [],
      });
    }
  });

  test("OsmBuildings applies on the globe and in the sky, forcing World Terrain", () => {
    for (const viewMode of ["3D", "Sky"]) {
      expect(surfaceEffects("OsmBuildings", viewMode)).toMatchObject({
        tileset: "OsmBuildings",
        hideGlobe: false,
        terrain: "CesiumWorldTerrain",
        inert: ["terrain"],
      });
    }
  });

  // It adds to the globe rather than replacing it, so the imagery underneath is
  // still the map the user picked.
  test("OsmBuildings leaves the imagery selection meaningful", () => {
    expect(surfaceEffects("OsmBuildings", "3D").inert).not.toContain("layers");
  });

  test("GooglePhotorealistic hides the globe, taking imagery and terrain with it", () => {
    expect(surfaceEffects("GooglePhotorealistic", "Sky")).toMatchObject({
      tileset: "GooglePhotorealistic",
      hideGlobe: true,
      inert: ["layers", "terrain"],
    });
  });

  // The terrain is not overridden but not honoured either: a hidden globe loads
  // no terrain at all, so the user's choice simply waits.
  test("GooglePhotorealistic imposes no terrain of its own", () => {
    expect(surfaceEffects("GooglePhotorealistic", "Sky").terrain).toBeUndefined();
  });

  test("GooglePhotorealistic is the sky view only", () => {
    for (const viewMode of ["3D", "2D", "Columbus"]) {
      const effects = surfaceEffects("GooglePhotorealistic", viewMode);
      expect(effects.tileset).toBeUndefined();
      expect(effects.unavailable).toContain("GooglePhotorealistic");
    }
    expect(surfaceEffects("GooglePhotorealistic", "Sky").unavailable).not.toContain("GooglePhotorealistic");
  });

  test("no surface model applies in 2D or Columbus", () => {
    for (const viewMode of ["2D", "Columbus"]) {
      expect(surfaceEffects("OsmBuildings", viewMode).tileset).toBeUndefined();
      expect(surfaceEffects("GooglePhotorealistic", viewMode).tileset).toBeUndefined();
      expect(surfaceEffects("None", viewMode).unavailable).not.toContain("None");
    }
  });

  // Suppression, not deselection: a model that cannot apply here takes nothing
  // else with it, so the imagery and terrain controls still tell the truth.
  test("a suppressed model leaves the other groups alone", () => {
    expect(surfaceEffects("GooglePhotorealistic", "3D")).toMatchObject({
      hideGlobe: false,
      terrain: undefined,
      inert: [],
    });
  });

  // The url is validated before it reaches the store, but the matrix is asked
  // about the store's value and must not be the thing that throws.
  test("an unknown name is read as None", () => {
    expect(surfaceEffects("Garbage", "Sky")).toMatchObject({ tileset: undefined, hideGlobe: false, inert: [] });
  });

  test("an unknown view mode grounds every model", () => {
    const effects = surfaceEffects("OsmBuildings", "Garbage");
    expect(effects.tileset).toBeUndefined();
    expect(effects.unavailable).toEqual(["None", "OsmBuildings", "GooglePhotorealistic"]);
  });
});

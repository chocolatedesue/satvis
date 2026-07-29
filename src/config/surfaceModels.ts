// The surface model vocabulary, and every consequence of picking one.
//
// Kept here, free of Cesium, because three places have to agree about what a
// selection implies and none of them should restate it: the url schema, the Map
// menu (which has to say when a control no longer describes the picture), and
// SurfaceModel (which executes it). The matrix is also the part worth testing —
// see surfaceModels.test.ts.
//
// The two models are deliberately not symmetric. OsmBuildings adds extruded
// footprints to the globe's own surface; GooglePhotorealistic *is* the surface,
// ground and vegetation and buildings in one mesh, so the globe underneath has
// to go. See docs/adr/0005-surface-models.md.

import { SKY_MODE } from "./viewModes";

export const SURFACE_MODELS = ["None", "OsmBuildings", "GooglePhotorealistic"] as const;
export type SurfaceModel = (typeof SURFACE_MODELS)[number];

/** Everything but the absence of one — the names that name a tileset. */
export type SurfaceTileset = Exclude<SurfaceModel, "None">;

/** The Map menu groups whose selection a surface model can render meaningless. */
export type MapGroup = "layers" | "terrain";

interface SurfaceModelRules {
  /**
   * The view modes the model applies in.
   *
   * GooglePhotorealistic is the sky view only, and that is a cost decision, not
   * a technical one: streamed from a fixed viewpoint looking up, tile loading is
   * bounded by where the observer stands, where on the globe it is bounded only
   * by how far someone cares to fly. Widening it is this one line.
   *
   * Neither applies in 2D or Columbus. Cesium does not refuse a tileset there —
   * `Cesium3DTile` carries a 2D screen-space-error branch — so this is a choice
   * too: full tile bandwidth for geometry that reads as broken is worse than
   * nothing.
   */
  viewModes: readonly string[];
  /** Whether the model replaces the globe's surface rather than adding to it. */
  hidesGlobe: boolean;
  /** The terrain the model's heights assume, forced for as long as it is up. */
  terrain?: string;
}

const RULES: Record<SurfaceModel, SurfaceModelRules> = {
  None: {
    viewModes: ["3D", "2D", "Columbus", SKY_MODE],
    hidesGlobe: false,
  },
  OsmBuildings: {
    viewModes: ["3D", SKY_MODE],
    hidesGlobe: false,
    // The tileset is authored against Cesium World Terrain and Cesium has no
    // ground-clamping for tilesets, so any other terrain leaves the buildings
    // floating or buried by the difference — metres in flat country, far more in
    // the mountains, and worst of all directly under a sky-view observer.
    terrain: "CesiumWorldTerrain",
  },
  GooglePhotorealistic: {
    viewModes: [SKY_MODE],
    hidesGlobe: true,
  },
};

export interface SurfaceEffects {
  /** The tileset the scene should hold, or undefined for none. */
  tileset: SurfaceTileset | undefined;
  hideGlobe: boolean;
  /** Terrain to impose over the user's choice, or undefined to honour it. */
  terrain: string | undefined;
  /** Groups whose controls no longer describe what is drawn. */
  inert: readonly MapGroup[];
  /**
   * Models that cannot apply in this view mode. They stay selectable — arming
   * one before entering the sky view is a reasonable thing to do, and it is what
   * makes `?surface=GooglePhotorealistic&scene=Sky` a working link — so the menu
   * annotates them rather than disabling them.
   */
  unavailable: readonly SurfaceModel[];
}

export function isSurfaceModel(value: string): value is SurfaceModel {
  return (SURFACE_MODELS as readonly string[]).includes(value);
}

/**
 * What a selection means in a given view mode: what to draw, what to hide, what
 * to override, and what the menu should stop claiming.
 *
 * Total in both arguments, and the single source for all four answers, so the
 * menu's annotations cannot drift from what the scene actually does.
 */
export function surfaceEffects(surfaceModel: string, viewMode: string): SurfaceEffects {
  const unavailable = SURFACE_MODELS.filter((name) => !RULES[name].viewModes.includes(viewMode));
  const selected: SurfaceModel = isSurfaceModel(surfaceModel) ? surfaceModel : "None";
  const rules = RULES[selected];
  // Suppressed, never deselected: an unavailable model keeps its place in the
  // store and the url, so leaving 2D or entering the sky view brings it back
  // rather than making the user ask twice.
  const active = selected !== "None" && rules.viewModes.includes(viewMode);
  if (!active) {
    return { tileset: undefined, hideGlobe: false, terrain: undefined, inert: [], unavailable };
  }

  const inert: MapGroup[] = [];
  // Nothing is drawn of the globe, so neither its imagery nor its terrain is.
  if (rules.hidesGlobe) {
    inert.push("layers", "terrain");
  } else if (rules.terrain !== undefined) {
    inert.push("terrain");
  }
  return {
    tileset: selected as SurfaceTileset,
    hideGlobe: rules.hidesGlobe,
    terrain: rules.terrain,
    inert,
    unavailable,
  };
}

/** The names a user may select, for the url schema and the menu. */
export function surfaceModelNames(): readonly string[] {
  return SURFACE_MODELS;
}

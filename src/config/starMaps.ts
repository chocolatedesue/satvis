// Which star field goes behind the globe.
//
// Kept here, free of Cesium, for the same reason as src/config/layers.ts and
// src/config/rendering.ts: the url schema, the Map menu and CesiumController all
// need the list, and only the controller is allowed to know what a `SkyBox` is.

/**
 * The star maps the menu offers, in the order it offers them.
 *
 * Named for the catalogue and the cube map face size rather than by rank: the
 * size is what separates one cut of a catalogue from another, where a relative
 * name leaves a reader guessing and has to be renamed the moment a third map
 * arrives.
 *
 * `Tycho1K` is the one Cesium ships in its own assets — 1024x1024 per face at
 * JPEG quality 80, about 850 kB for all six, drawn from Tycho-2's ~2.5 million
 * stars. It is also the one that always exists: it lives under `cesium/Assets`,
 * which the service worker precaches wholesale.
 *
 * `DeepStar2K` is a different catalogue at twice the size — NASA SVS Deep Star
 * Maps 2020, 1.7 billion stars from Hipparcos-2, Tycho-2 and Gaia DR2, built by
 * `scripts/starmap/generate.sh`. Denser and better coloured than Tycho, and
 * reprojected from linear-light EXR rather than resampled from an already
 * tone-mapped JPEG. Generated rather than committed, so it is missing from a
 * checkout where nobody has run the generator (see `starMapAvailable`).
 *
 * Both cost the same frame time and differ only in resident memory: Cesium
 * builds no mipmaps for a sky box, so six 2048 RGBA faces are ~100 MB against
 * ~25 MB for `Tycho1K`, and the draw is one textured cube either way.
 */
export const STAR_MAPS = ["Tycho1K", "DeepStar2K"] as const;

export type StarMapName = (typeof STAR_MAPS)[number];

/**
 * The map that cannot be missing, and so the one everything falls back to.
 *
 * Named rather than written out at each site — the store's default, the menu's
 * opening list and the loader's fallback are the same decision three times, and
 * a literal in each is three places to miss when it changes.
 */
export const BUILTIN_STAR_MAP: StarMapName = "Tycho1K";

/** An optional star map: where its faces live, and how to obtain them. */
interface StarMapAsset {
  /** Path stem the six faces hang off — `_px.jpg` and friends. */
  prefix: string;
  /** What to run to get it, for the warning when it turns out to be absent. */
  recovery: string;
}

// `Tycho1K` is deliberately absent: Cesium resolves its own faces through
// `buildModuleUrl`, and restating them here would be a second copy of a path
// that moves with the Cesium version. Everything else can be missing at runtime,
// which is why the controller fetches these itself rather than handing the urls
// to Cesium. See `CesiumController.applyStarMap`.
const ASSETS: Partial<Record<StarMapName, StarMapAsset>> = {
  DeepStar2K: {
    prefix: "data/generated/starmap/deepstar_2020_2048",
    recovery: "scripts/starmap/generate.sh",
  },
};

/** The six cube map faces, named the way Cesium's `SkyBox` wants them. */
export interface StarMapSources {
  positiveX: string;
  negativeX: string;
  positiveY: string;
  negativeY: string;
  positiveZ: string;
  negativeZ: string;
}

/** Where a star map's faces come from, or `undefined` for Cesium's own. */
export function starMapSources(name: string): StarMapSources | undefined {
  const asset = ASSETS[name as StarMapName];
  if (asset === undefined) {
    return undefined;
  }
  const { prefix } = asset;
  return {
    positiveX: `${prefix}_px.jpg`,
    negativeX: `${prefix}_mx.jpg`,
    positiveY: `${prefix}_py.jpg`,
    negativeY: `${prefix}_my.jpg`,
    positiveZ: `${prefix}_pz.jpg`,
    negativeZ: `${prefix}_mz.jpg`,
  };
}

/**
 * What to run to obtain a star map that turned out to be missing.
 *
 * Lives with the path rather than at the warning, so the two cannot drift: an
 * earlier version told everyone to init the submodule, which was the wrong
 * advice for the one map that is built rather than checked out.
 */
export function starMapRecovery(name: string): string | undefined {
  return ASSETS[name as StarMapName]?.recovery;
}

// One probe per map for the life of the page. Whether an asset is on the server
// does not change under someone's feet, and the menu asks every time it renders.
const probes = new Map<string, Promise<boolean>>();

/**
 * Whether a star map's faces are actually on the server.
 *
 * An optional map can be absent from a working deployment, so offering it
 * unconditionally means offering a control that does nothing. This is the same
 * shape as `pixelRatiosFor` in src/config/rendering.ts: the *menu* narrows to
 * what is usable while the url vocabulary stays wide, so `?stars=DeepStar2K`
 * still means something to someone who has the asset, and someone who does not
 * gets the fallback in sceneSync rather than a silently different sky.
 *
 * A `GET`, not a `HEAD`, for the reason the imagery probe gives in
 * `CesiumLayerProviders.ts`: the Cache API ignores requests whose method is not
 * GET, so a HEAD never sees the service worker's runtime cache. Ranged to one
 * byte because unlike that probe's small xml manifest, a face is ~600 kB and
 * this runs on every page load for a map nobody may select. A cache hit ignores
 * the range and returns the whole stored response, which is exactly what makes
 * the offline case work; a miss costs one byte over the wire.
 *
 * The status alone is not enough: a dev server or an SPA fallback answering 200
 * with `index.html` is not the asset being present, so the content type is
 * checked too.
 *
 * A request that never gets an answer is treated as *available*, which looks
 * backwards until you consider what it means. No answer is not evidence of
 * absence, and guessing wrong that way only costs a fallback that already
 * exists.
 */
export async function starMapAvailable(name: string): Promise<boolean> {
  const sources = starMapSources(name);
  if (sources === undefined) {
    return (STAR_MAPS as readonly string[]).includes(name);
  }
  let probe = probes.get(name);
  if (probe === undefined) {
    probe = fetch(sources.positiveX, { headers: { Range: "bytes=0-0" } })
      .then((response) => response.ok && (response.headers.get("content-type") ?? "").startsWith("image/"))
      .catch(() => true);
    probes.set(name, probe);
  }
  return probe;
}

/** The maps worth putting in the menu, in `STAR_MAPS` order. */
export async function availableStarMaps(): Promise<StarMapName[]> {
  const present = await Promise.all(STAR_MAPS.map((name) => starMapAvailable(name)));
  return STAR_MAPS.filter((_, index) => present[index]);
}

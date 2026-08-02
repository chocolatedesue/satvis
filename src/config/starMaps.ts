// Which star field goes behind the globe.
//
// Kept here, free of Cesium, for the same reason as src/config/layers.ts and
// src/config/rendering.ts: the url schema, the Map menu and CesiumController all
// need the list, and only the controller is allowed to know what a `SkyBox` is.

/**
 * The star maps the menu offers, in the order it offers them.
 *
 * Named for the catalogue and the cube map face size rather than by rank: the
 * size is exactly what separates two cuts of one catalogue, where a relative
 * name leaves a reader guessing and has to be renamed the moment a third map
 * arrives.
 *
 * `Tycho1K` is the one Cesium ships in its own assets — 1024x1024 per face at
 * JPEG quality 80, about 850 kB for all six, drawn from Tycho-2's ~2.5 million
 * stars. It is also the only one that always exists: it lives under
 * `cesium/Assets`, which the service worker precaches wholesale, while the other
 * two are fetched on demand and can be absent entirely (see `starMapAvailable`).
 *
 * `Tycho2K` is the 2048x2048 cut of the same source, from the
 * `data/cesium-assets` submodule: four times the texels for about 3.6 MB, which
 * resolves the Milky Way into individual faint stars instead of a smear and
 * drops the JPEG ringing around bright ones.
 *
 * `DeepStar2K` is a different catalogue at the same size — NASA SVS Deep Star
 * Maps 2020, 1.7 billion stars from Hipparcos-2, Tycho-2 and Gaia DR2, built by
 * `scripts/starmap/generate.sh`. Denser and better coloured than Tycho at equal
 * resolution, and reprojected from linear-light EXR rather than resampled from
 * an already tone-mapped JPEG. Generated rather than committed, so it is missing
 * from a checkout where nobody has run the generator.
 *
 * All three cost the same frame time and differ only in resident memory: Cesium
 * builds no mipmaps for a sky box, so six 2048 RGBA faces are ~100 MB against
 * ~25 MB for `Tycho1K`, and the draw is one textured cube either way.
 */
export const STAR_MAPS = ["Tycho1K", "Tycho2K", "DeepStar2K"] as const;

export type StarMapName = (typeof STAR_MAPS)[number];

// Where each map's six faces live, for the maps that have urls to give.
// `Tycho1K` is deliberately absent: Cesium resolves its own through
// `buildModuleUrl`, and restating them here would be a second copy of a path
// that moves with the Cesium version.
//
// Both entries can be missing at runtime, for different reasons — the Tycho cut
// needs `git submodule update --init`, the Deep Star Maps cut needs someone to
// have run the generator — which is why the controller fetches these itself
// rather than handing the urls to Cesium. See `CesiumController.applyStarMap`.
const FACE_PREFIXES: Record<string, string> = {
  Tycho2K: "data/cesium-assets/stars/TychoSkymapII.t3_08192x04096/TychoSkymapII.t3_08192x04096_80",
  DeepStar2K: "data/generated/starmap/deepstar_2020_2048",
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
  const prefix = FACE_PREFIXES[name];
  if (prefix === undefined) {
    return undefined;
  }
  return {
    positiveX: `${prefix}_px.jpg`,
    negativeX: `${prefix}_mx.jpg`,
    positiveY: `${prefix}_py.jpg`,
    negativeY: `${prefix}_my.jpg`,
    positiveZ: `${prefix}_pz.jpg`,
    negativeZ: `${prefix}_mz.jpg`,
  };
}

// One probe per map for the life of the page. Whether an asset is on the server
// does not change under someone's feet, and the menu asks every time it renders.
const probes = new Map<string, Promise<boolean>>();

/**
 * Whether a star map's faces are actually on the server.
 *
 * Both non-builtin maps can be absent from a working deployment, so offering
 * them unconditionally means offering a control that does nothing. This is the
 * same shape as `pixelRatiosFor` in src/config/rendering.ts: the *menu* narrows
 * to what is usable while the url vocabulary stays wide, so `?stars=DeepStar2K`
 * still means something to someone who has the asset, and someone who does not
 * gets the fallback in sceneSync rather than a silently different sky.
 *
 * A HEAD that comes back as something other than an image is the interesting
 * case: a dev server or an SPA fallback answering 200 with `index.html` is not
 * the asset being present, which is why the content type is checked and not just
 * the status.
 *
 * A request that never gets an answer is treated as *available*, which looks
 * backwards until you consider what it means. Offline — a real case for this
 * app, which is a PWA — a HEAD fails while the faces may sit in the runtime
 * cache and load perfectly. No answer is not evidence of absence, and guessing
 * wrong that way only costs a fallback that already exists.
 */
export async function starMapAvailable(name: string): Promise<boolean> {
  const sources = starMapSources(name);
  if (sources === undefined) {
    return (STAR_MAPS as readonly string[]).includes(name);
  }
  let probe = probes.get(name);
  if (probe === undefined) {
    probe = fetch(sources.positiveX, { method: "HEAD" })
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

// Which star field goes behind the globe.
//
// Kept here, free of Cesium, for the same reason as src/config/layers.ts and
// src/config/rendering.ts: the url schema, the Map menu and CesiumController all
// need the list, and only the controller is allowed to know what a `SkyBox` is.

/**
 * The star maps the menu offers, in the order it offers them.
 *
 * Both are NASA's Tycho catalog skymap, so they are named for the catalogue and
 * their cube map face size rather than by rank. The two differ only in how much
 * of the 8192x4096 source survived the conversion, and the face size is exactly
 * that quantity — where a relative name would leave a reader guessing at it, and
 * would have to be renamed again the moment a third map arrived.
 *
 * `Tycho1K` is the one Cesium ships in its own assets — 1024x1024 per face at
 * JPEG quality 80, about 850 kB for all six. It is also the only one that works
 * on a first offline load: it lives under `cesium/Assets`, which the service
 * worker precaches wholesale, while `Tycho2K` is fetched on demand.
 *
 * `Tycho2K` is the 2048x2048 cut of the same source, from the
 * `data/cesium-assets` submodule: four times the texels for about 3.6 MB, which
 * resolves the Milky Way into individual faint stars instead of a smear and
 * drops the JPEG ringing around bright ones. It costs memory rather than frame
 * time — Cesium builds no mipmaps for a sky box, so six RGBA faces are ~100 MB
 * resident against ~25 MB for `Tycho1K`, and the draw itself is one textured
 * cube either way.
 */
export const STAR_MAPS = ["Tycho1K", "Tycho2K"] as const;

export type StarMapName = (typeof STAR_MAPS)[number];

// Same submodule as the offline imagery, and absent under the same conditions: a
// checkout without `git submodule update --init` has the app but not the asset.
// Which is why the controller fetches these itself rather than handing the urls
// to Cesium — see `CesiumController.applyStarMap`.
const TYCHO_2K_FACE_PREFIX = "data/cesium-assets/stars/TychoSkymapII.t3_08192x04096/TychoSkymapII.t3_08192x04096_80";

/** The six cube map faces, named the way Cesium's `SkyBox` wants them. */
export interface StarMapSources {
  positiveX: string;
  negativeX: string;
  positiveY: string;
  negativeY: string;
  positiveZ: string;
  negativeZ: string;
}

/**
 * Where a star map's faces come from, or `undefined` for the one whose faces
 * Cesium names itself.
 *
 * `Tycho1K` has no urls to give on purpose: Cesium resolves its own through
 * `buildModuleUrl`, and restating them here would be a second copy of a path
 * that moves with the Cesium version.
 */
export function starMapSources(name: string): StarMapSources | undefined {
  if (name !== "Tycho2K") {
    return undefined;
  }
  return {
    positiveX: `${TYCHO_2K_FACE_PREFIX}_px.jpg`,
    negativeX: `${TYCHO_2K_FACE_PREFIX}_mx.jpg`,
    positiveY: `${TYCHO_2K_FACE_PREFIX}_py.jpg`,
    negativeY: `${TYCHO_2K_FACE_PREFIX}_my.jpg`,
    positiveZ: `${TYCHO_2K_FACE_PREFIX}_pz.jpg`,
    negativeZ: `${TYCHO_2K_FACE_PREFIX}_mz.jpg`,
  };
}

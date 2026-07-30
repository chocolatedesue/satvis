// The surface model: the 3D tileset standing in for, or standing on, the globe's
// surface — and everything that follows from having one.
//
// This module owns the tileset and nothing else owns any part of it. What a
// selection *means* is not decided here: src/config/surfaceModels.ts holds the
// matrix, Cesium-free and tested, and this executes it. Rationale:
// docs/adr/0005-surface-models.md.
//
// Two consequences reach outside the tileset, so they arrive as callbacks rather
// than being reached for directly. Imposing a terrain belongs to the thing that
// owns the terrain (CesiumController.suppressTerrain), and reporting a failure
// belongs to whatever can put the selection back.

import { Cartesian3, Cartographic, type Cesium3DTileset, createGooglePhotorealistic3DTileset, createOsmBuildingsAsync, type Scene } from "@cesium/engine";

import { type SurfaceEffects, surfaceEffects, type SurfaceTileset } from "../config/surfaceModels";
import type { Observer } from "./skyGeometry";
import { DeviceDetect } from "./util/DeviceDetect";

export interface SurfaceModelDeps {
  scene: Scene;
  /** Impose a terrain provider, or `undefined` to honour the user's choice again. */
  setTerrainOverride: (name: string | undefined) => void;
  /** A selection that could not be loaded, and is therefore not in effect. */
  onFailure: (name: SurfaceTileset, error: unknown) => void;
}

/**
 * What the photorealistic mesh is allowed to spend.
 *
 * Cesium's defaults for this tileset are 1.5 GB of tile cache plus a 1 GB
 * overflow, sized for a desktop flying the globe. The sky view is the opposite
 * case — one viewpoint, a neighbourhood of tiles, frequently a phone — so the
 * budget comes down and `dynamicScreenSpaceError`, which Cesium recommends for
 * photogrammetry, drops the detail of tiles further from the camera.
 */
function googleTilesetOptions(): Cesium3DTileset.ConstructorOptions {
  // A coarse pointer is the honest proxy for "a phone or tablet", and it catches
  // Android, which an iOS test does not. Not `inIframe`: an embed on a desktop has
  // a desktop's memory, and it was the memory this budget is about.
  const constrained = DeviceDetect.isIos() || !DeviceDetect.canHover();
  return {
    cacheBytes: (constrained ? 192 : 512) * 1024 * 1024,
    maximumCacheOverflowBytes: (constrained ? 64 : 256) * 1024 * 1024,
    dynamicScreenSpaceError: true,
    // Relaxed on constrained devices only; the desktop value is Cesium's own
    // default, which is to say the desktop is not asked to give up any detail.
    maximumScreenSpaceError: constrained ? 24 : 16,
    // Google's Map Tiles policies ask for the attributions on screen, in a line
    // along the bottom, rather than behind the collapsed "Data attribution" link
    // Cesium defaults to. Cesium reads its own default as the minimum compliant
    // behaviour; this follows Google's wording instead.
    showCreditsOnScreen: true,
    // Left at Cesium's default `true` deliberately: with the globe hidden, the
    // mesh is the only thing stopping the camera from dropping through the ground.
  };
}

/**
 * How each model is built. Here rather than beside the imagery and terrain
 * registries: a surface model is not a layer provider (see CONTEXT.md), this is
 * its only consumer, and creation and lifetime belong to the same owner.
 */
const SURFACE_TILESETS: Record<SurfaceTileset, () => Promise<Cesium3DTileset>> = {
  // No options: this helper takes styling only, and its default style is the one
  // worth having — it colours each building from the tileset's own `cesium#color`
  // property. Its "© OpenStreetMap contributors" credit is applied by Cesium in
  // the attribution display, which is where an ion asset's credits belong; only
  // Google's policies ask for more than that.
  OsmBuildings: () => createOsmBuildingsAsync(),
  // No Google Maps API key of our own, so this resolves ion asset 2275207 with
  // `Ion.defaultAccessToken`. `onlyUsingWithGoogleGeocoder` only silences a
  // one-time console warning about geocoders; this app has none at all.
  GooglePhotorealistic: () => createGooglePhotorealistic3DTileset({ onlyUsingWithGoogleGeocoder: true }, googleTilesetOptions()),
};

export class SurfaceModel {
  #deps: SurfaceModelDeps;

  #tileset: Cesium3DTileset | undefined;

  /** Which model `#tileset` is, and what a repeat call can therefore skip. */
  #name: SurfaceTileset | undefined;

  /**
   * Guards the async creation. A user can pick a second model, or leave the view
   * mode that allowed the first, while a tileset is still being resolved — and
   * that answer is then about a scene that no longer wants it.
   */
  #generation = 0;

  constructor(deps: SurfaceModelDeps) {
    this.#deps = deps;
  }

  /** The model currently drawing, if any. */
  get active(): SurfaceTileset | undefined {
    return this.#name;
  }

  /**
   * Make the scene match a selection in a view mode.
   *
   * Idempotent, and safe to call for a change to either argument: the effects are
   * derived from both, so leaving the sky view takes the photorealistic mesh down
   * as surely as choosing None does.
   */
  async apply(surfaceModel: string, viewMode: string): Promise<void> {
    const effects = surfaceEffects(surfaceModel, viewMode);
    const generation = ++this.#generation;

    this.#deps.setTerrainOverride(effects.terrain);

    if (effects.tileset === this.#name) {
      // Already right. The globe still has to be re-asserted, because this may be
      // the call that hid it — `hideGlobe` can change with the view mode while
      // the tileset stays exactly as it was.
      this.#syncGlobe(effects);
      return;
    }

    this.#remove();
    if (!effects.tileset) {
      this.#syncGlobe(effects);
      return;
    }

    // The globe stays up until the tileset is actually there. Hiding it first
    // would trade a globe for a black void for as long as the network takes.
    const tileset = await this.#create(effects.tileset);
    if (generation !== this.#generation) {
      // Overtaken while loading. Destroy what arrived rather than adding it: the
      // call that overtook this one has already put the scene the way it wants it.
      tileset?.destroy();
      return;
    }
    if (!tileset) {
      this.#syncGlobe(effects);
      return;
    }

    this.#tileset = tileset;
    this.#name = effects.tileset;
    this.#deps.scene.primitives.add(tileset);
    this.#watchTileFailures(tileset, effects.tileset);
    this.#syncGlobe(effects);
    // The stack arrived asynchronously and `requestRenderMode` is on, so without
    // this the tileset is never traversed and nothing appears — the same reason
    // the imagery setter ends this way.
    this.#deps.scene.requestRender();
  }

  /**
   * The height of the model's surface under a point, or undefined when there is
   * no model, no support for asking, or no geometry there.
   *
   * "Most detailed" rather than a per-frame sample: this is asked when the sky
   * view arrives somewhere, and the honest answer needs the tiles at that spot
   * loaded rather than whichever coarse ancestor happens to be up. Note it clamps
   * to the *top* of what is there, so standing where a building stands gives its
   * roof — see docs/adr/0005-surface-models.md.
   */
  async surfaceHeight(observer: Observer): Promise<number | undefined> {
    const { scene } = this.#deps;
    const tileset = this.#tileset;
    if (!tileset || !scene.clampToHeightSupported) {
      return undefined;
    }
    const [clamped] = await scene.clampToHeightMostDetailed([Cartesian3.fromDegrees(observer.lon, observer.lat, 0)]);
    // Guarded on the tileset rather than on `#generation`: a re-apply that
    // changes nothing must not throw away a measurement in flight, and a model
    // that actually went away has no height to report.
    if (this.#tileset !== tileset || !clamped) {
      return undefined;
    }
    return Cartographic.fromCartesian(clamped).height;
  }

  /**
   * Report tiles that fail after the tileset is up, and only report them.
   *
   * A single failed tile is not grounds for tearing the surface down — the rest of
   * the scene is fine and the next camera move may not even ask for it again. But
   * it is worth one line, because a quota that runs out mid-session looks exactly
   * like this and nothing else would say so.
   *
   * Bounded to the first failure on purpose: the same causes that produce one
   * produce hundreds, and a console flooded by them is no more informative than a
   * console with one line in it.
   */
  #watchTileFailures(tileset: Cesium3DTileset, name: SurfaceTileset): void {
    let reported = false;
    tileset.tileFailed.addEventListener((error: { url?: string; message?: string }) => {
      if (reported) {
        return;
      }
      reported = true;
      console.warn(`Surface model ${name} failed to load a tile, and further tile failures will not be reported`, error.url, error.message);
    });
  }

  async #create(name: SurfaceTileset): Promise<Cesium3DTileset | undefined> {
    try {
      return await SURFACE_TILESETS[name]();
    } catch (error) {
      // Every way this fails looks the same from here — a token ion rejects, an
      // exhausted quota, a network that is not there — and none of them leave a
      // selection worth keeping.
      console.error(`Surface model ${name} failed to load`, error);
      this.#deps.onFailure(name, error);
      return undefined;
    }
  }

  #remove(): void {
    const tileset = this.#tileset;
    this.#tileset = undefined;
    this.#name = undefined;
    if (tileset) {
      // `remove` destroys it, which is what releases the tile cache — up to half
      // a gigabyte for the photorealistic mesh.
      this.#deps.scene.primitives.remove(tileset);
      this.#deps.scene.requestRender();
    }
  }

  /**
   * The globe is visible unless a surface model is actually standing in for it —
   * asked of the tileset rather than of the selection, so a model that failed to
   * load, or has not arrived yet, leaves a globe rather than a black void.
   *
   * Only ever driven from here, so there is no one else's `show` to preserve.
   */
  #syncGlobe(effects: SurfaceEffects): void {
    const show = !(effects.hideGlobe && this.#tileset !== undefined);
    const { globe } = this.#deps.scene;
    if (globe.show !== show) {
      globe.show = show;
      this.#deps.scene.requestRender();
    }
  }
}

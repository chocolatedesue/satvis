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

import { Cartesian3, Cartographic, type Cesium3DTileset, type Scene } from "@cesium/engine";

import { type SurfaceEffects, surfaceEffects, type SurfaceTileset } from "../config/surfaceModels";
import { surfaceModelTilesets } from "./CesiumLayerProviders";
import type { Observer } from "./skyGeometry";

export interface SurfaceModelDeps {
  scene: Scene;
  /** Impose a terrain provider, or `undefined` to honour the user's choice again. */
  setTerrainOverride: (name: string | undefined) => void;
  /** A selection that could not be loaded, and is therefore not in effect. */
  onFailure: (name: SurfaceTileset, error: unknown) => void;
  /** A selection that is now drawing, for telemetry. */
  onLoad?: (name: SurfaceTileset) => void;
}

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
    this.#syncGlobe(effects);
    this.#deps.onLoad?.(effects.tileset);
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

  async #create(name: SurfaceTileset): Promise<Cesium3DTileset | undefined> {
    try {
      return await surfaceModelTilesets[name].create();
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

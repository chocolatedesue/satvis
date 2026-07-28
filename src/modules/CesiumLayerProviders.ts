import {
  ArcGisMapServerImageryProvider,
  ArcGISTiledElevationTerrainProvider,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
  type ImageryProvider,
  OpenStreetMapImageryProvider,
  type TerrainProvider,
  TileCoordinatesImageryProvider,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  WebMapServiceImageryProvider,
} from "@cesium/engine";

import type { LayerAvailability } from "../config/layers";

// The high-resolution offline tiles live in the `data/cesium-assets` submodule,
// which `git worktree add` does not populate — so in a fresh worktree they are
// simply absent, while `Offline` (bundled with @cesium/engine, copied out of
// node_modules) is always there.
const HIGHRES_NATURAL_EARTH = "data/cesium-assets/imagery/NaturalEarthII";

let highresProbe: Promise<boolean> | undefined;

/**
 * Whether the high-resolution offline tiles are actually present.
 *
 * Cesium cannot answer this: `TileMapServiceImageryProvider.fromUrl` treats a
 * missing `tilemapresource.xml` as "carry on with defaults" and resolves
 * happily, then requests thousands of tiles that 404 behind a blank globe.
 *
 * A `GET`, deliberately, and not a `HEAD`: the Cache API ignores requests whose
 * method is not GET, so a HEAD would miss the service worker's tile cache and
 * report the imagery missing to someone who is merely offline — which is the
 * one situation an offline layer exists for. Cached, because the answer cannot
 * change within a session and the layer stack is rebuilt on every change.
 */
function highresAvailable(): Promise<boolean> {
  highresProbe ??= fetch(`${HIGHRES_NATURAL_EARTH}/tilemapresource.xml`)
    .then((response) => response.ok)
    .catch(() => false);
  return highresProbe;
}

export interface ImageryProviderEntry {
  create: () => ImageryProvider | Promise<ImageryProvider>;
  alpha: number;
  base: boolean;
  /**
   * Present only where the tiles are data that may not be there. Absent means
   * the provider is always usable — either it is remote, or `pnpm install`
   * guarantees it.
   */
  availability?: LayerAvailability;
}

export interface TerrainProviderEntry {
  create: () => TerrainProvider | Promise<TerrainProvider>;
  visible?: boolean;
}

export const imageryProviders: Record<string, ImageryProviderEntry> = {
  Offline: {
    create: () => TileMapServiceImageryProvider.fromUrl("/cesium/Assets/Textures/NaturalEarthII"),
    alpha: 1,
    base: true,
  },
  OfflineHighres: {
    create: () =>
      TileMapServiceImageryProvider.fromUrl(HIGHRES_NATURAL_EARTH, {
        maximumLevel: 5,
        credit: "Imagery courtesy Natural Earth",
      }),
    alpha: 1,
    base: true,
    // Falls back to the bundled copy of the same map. They are not one layer:
    // `Offline` is precached by the service worker and so is guaranteed with no
    // network, while these tiles are only cached as they are viewed.
    availability: { available: highresAvailable, fallback: "Offline" },
  },
  ArcGis: {
    create: () =>
      ArcGisMapServerImageryProvider.fromUrl("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer", {
        enablePickFeatures: false,
      }),
    alpha: 1,
    base: true,
  },
  OSM: {
    create: () =>
      new OpenStreetMapImageryProvider({
        url: "https://a.tile.openstreetmap.org/",
      }),
    alpha: 1,
    base: true,
  },
  Topo: {
    create: () =>
      new UrlTemplateImageryProvider({
        url: "https://api.maptiler.com/maps/topo-v2/{z}/{x}/{y}@2x.png?key=tiHE8Ed08u6ZoFjbE32Z",
        credit: `<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>`,
      }),
    alpha: 1,
    base: true,
  },
  BlackMarble: {
    create: () =>
      new WebMapServiceImageryProvider({
        url: "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi",
        layers: "VIIRS_Black_Marble",
        parameters: {
          format: "image/png",
        },
        tileWidth: 512,
        tileHeight: 512,
        credit: "NASA Global Imagery Browse Services for EOSDIS",
      }),
    alpha: 1,
    base: true,
  },
  Tiles: {
    create: () => new TileCoordinatesImageryProvider(),
    alpha: 1,
    base: false,
  },
  "GOES-IR": {
    create: () =>
      new WebMapServiceImageryProvider({
        url: "https://mesonet.agron.iastate.edu/cgi-bin/wms/goes/conus_ir.cgi?",
        layers: "goes_conus_ir",
        credit: "Infrared data courtesy Iowa Environmental Mesonet",
        parameters: {
          transparent: "true",
          format: "image/png",
        },
      }),
    alpha: 0.5,
    base: false,
  },
  Nextrad: {
    create: () =>
      new WebMapServiceImageryProvider({
        url: "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi?",
        layers: "nexrad-n0r",
        credit: "US Radar data courtesy Iowa Environmental Mesonet",
        parameters: {
          transparent: "true",
          format: "image/png",
        },
      }),
    alpha: 0.5,
    base: false,
  },
};

export const terrainProviders: Record<string, TerrainProviderEntry> = {
  None: {
    create: () => new EllipsoidTerrainProvider(),
  },
  Maptiler: {
    create: () =>
      CesiumTerrainProvider.fromUrl("https://api.maptiler.com/tiles/terrain-quantized-mesh/?key=tiHE8Ed08u6ZoFjbE32Z", {
        credit:
          '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
        requestVertexNormals: true,
      }),
  },
  ArcGIS: {
    create: () => ArcGISTiledElevationTerrainProvider.fromUrl("https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer"),
    visible: false,
  },
};

// Name accessors, so the url schema and CesiumController share one source of
// truth for what is selectable instead of restating the list.

export function imageryProviderNames(): string[] {
  return Object.keys(imageryProviders);
}

export function baseLayerNames(): string[] {
  return Object.entries(imageryProviders)
    .filter(([, entry]) => entry.base)
    .map(([name]) => name);
}

export function overlayLayerNames(): string[] {
  return Object.entries(imageryProviders)
    .filter(([, entry]) => !entry.base)
    .map(([name]) => name);
}

/** How to check a provider's data is there, for the providers that can be missing. */
export function layerAvailability(provider: string): LayerAvailability | undefined {
  return imageryProviders[provider]?.availability;
}

/** Terrain providers a user may select. `ArcGIS` is registered but hidden. */
export function terrainProviderNames(): string[] {
  return Object.entries(terrainProviders)
    .filter(([, entry]) => entry.visible ?? true)
    .map(([name]) => name);
}

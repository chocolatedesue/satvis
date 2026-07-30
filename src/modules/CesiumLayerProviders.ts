import {
  ArcGisMapServerImageryProvider,
  ArcGISTiledElevationTerrainProvider,
  CesiumTerrainProvider,
  createWorldTerrainAsync,
  EllipsoidTerrainProvider,
  type ImageryProvider,
  OpenStreetMapImageryProvider,
  type TerrainProvider,
  TileCoordinatesImageryProvider,
  TileMapServiceImageryProvider,
  WebMapServiceImageryProvider,
} from "@cesium/engine";

import { formatLayer, parseLayer } from "../config/layers";

// The high-resolution offline tiles live in the `data/cesium-assets` submodule,
// which `git worktree add` does not populate — so in a fresh worktree they are
// simply absent, while `Offline` (bundled with @cesium/engine, copied out of
// node_modules) is always there.
const HIGHRES_NATURAL_EARTH = "data/cesium-assets/imagery/NaturalEarthII";

let highresProbe: Promise<boolean> | undefined;

/**
 * The layer stack with `OfflineHighres` swapped for `Offline` when its tiles are
 * not there, or undefined when nothing needs changing.
 *
 * Cesium cannot report the absence itself: `TileMapServiceImageryProvider.fromUrl`
 * treats a missing `tilemapresource.xml` as "carry on with defaults" and resolves
 * happily, then requests thousands of tiles that 404 behind a blank globe. So the
 * manifest is fetched here instead.
 *
 * A `GET`, deliberately, and not a `HEAD`: the Cache API ignores requests whose
 * method is not GET, so a HEAD would miss the service worker's tile cache and
 * report the imagery missing to someone who is merely offline — which is the one
 * situation an offline layer exists for. The answer is cached, since it cannot
 * change within a session.
 *
 * Hardcoded to the one pair rather than expressed as a general capability of the
 * registry: this is the only provider backed by data that `pnpm install` does not
 * guarantee, and a framework for a single case is harder to read than the case.
 */
export async function offlineFallback(layers: readonly string[]): Promise<string[] | undefined> {
  if (!layers.some((token) => parseLayer(token)?.provider === "OfflineHighres")) {
    return undefined;
  }
  highresProbe ??= fetch(`${HIGHRES_NATURAL_EARTH}/tilemapresource.xml`)
    .then((response) => response.ok)
    .catch(() => false);
  if (await highresProbe) {
    return undefined;
  }
  console.warn("High-resolution offline imagery is missing, falling back to Offline. Run `git submodule update --init` to fetch data/cesium-assets.");
  // Through the codec so an opacity survives: the user asked for a base map at a
  // given opacity, and only the source of its tiles turned out to be wrong.
  return layers.map((token) => {
    const selection = parseLayer(token);
    return selection?.provider === "OfflineHighres" ? formatLayer({ ...selection, provider: "Offline" }) : token;
  });
}

export interface ImageryProviderEntry {
  create: () => ImageryProvider | Promise<ImageryProvider>;
  alpha: number;
  base: boolean;
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
  // The terrain OSM Buildings was authored against, which is why selecting that
  // surface model forces this one — see src/config/surfaceModels.ts. Needs the
  // ion token, so it is the one terrain that can fail for a reason other than
  // the network.
  CesiumWorldTerrain: {
    // Vertex normals because `globe.enableLighting` is on: without them the
    // terrain is shaded off the ellipsoid normal and the relief goes flat.
    create: () => createWorldTerrainAsync({ requestVertexNormals: true }),
  },
  // Free and keyless, which is the point of it. Best-effort uptime and no SLA, so
  // it is offered beside the two hosted options rather than instead of them.
  //
  // The `ellipsoid` variant, matching every other terrain here: Cesium wants
  // heights above the ellipsoid, and the geoid variant would sit tens of metres
  // out. The water mask is advertised but not requested — it would oblige a second
  // attribution line ("Protomaps · © OpenStreetMap contributors") for an effect on
  // the oceans that this app never looks at.
  ReEarth: {
    create: () =>
      CesiumTerrainProvider.fromUrl("https://terrain.reearth.land/cesium-mesh/ellipsoid", {
        credit: '<a href="https://terrain.reearth.land/" target="_blank">Re:Earth Terrain</a> · Mapterhorn (CC BY 4.0)',
        requestVertexNormals: true,
      }),
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

/** Terrain providers a user may select. `ArcGIS` is registered but hidden. */
export function terrainProviderNames(): string[] {
  return Object.entries(terrainProviders)
    .filter(([, entry]) => entry.visible ?? true)
    .map(([name]) => name);
}

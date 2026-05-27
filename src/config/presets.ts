/**
 * Configuration manager for different application presets
 * Maps routes to their respective configurations and TLE data
 */

export type TleDataEntry = [path: string, tags: string[]];

export interface PresetConfig {
  sat?: {
    enabledTags?: string[];
    enabledComponents?: string[];
    overpassMode?: string;
  };
  cesium?: {
    layers?: string[];
  };
}

export interface Preset {
  title: string;
  description?: string;
  config: PresetConfig;
  tleData: TleDataEntry[];
}

export const presets: Record<string, Preset> = {
  default: {
    title: "Satellite Orbit Visualization",
    config: {
      sat: {
        enabledTags: ["Weather"],
      },
    },
    tleData: [
      ["data/tle/groups/cubesat.txt", ["Cubesat"]],
      ["data/tle/groups/globalstar.txt", ["Globalstar"]],
      ["data/tle/groups/gnss.txt", ["GNSS"]],
      ["data/tle/groups/iridium-NEXT.txt", ["IridiumNEXT"]],
      ["data/tle/groups/last-30-days.txt", ["New"]],
      ["data/tle/groups/oneweb.txt", ["OneWeb"]],
      ["data/tle/groups/planet.txt", ["Planet"]],
      ["data/tle/groups/resource.txt", ["Resource"]],
      ["data/tle/groups/science.txt", ["Science"]],
      ["data/tle/groups/spire.txt", ["Spire"]],
      ["data/tle/groups/starlink.txt", ["Starlink"]],
      ["data/tle/groups/stations.txt", ["Stations"]],
      ["data/tle/groups/weather.txt", ["Weather"]],
      ["data/tle/groups/eutelsat.txt", ["Eutelsat"]],
      // ["data/tle/groups/active.txt", ["Active"]],
    ],
  },
  move: {
    title: "MOVE Satellite Orbit Visualization",
    config: {
      sat: {
        enabledTags: ["MOVE"],
      },
    },
    tleData: [["data/tle/move.txt", ["MOVE"]]],
  },
  ot: {
    title: "OT Satellite Orbit Visualization",
    config: {
      sat: {
        enabledTags: ["OT"],
        enabledComponents: ["Point", "Label", "Orbit", "Sensor cone", "Ground track"],
        overpassMode: "swath",
      },
      cesium: {
        layers: ["ArcGis"],
      },
    },
    tleData: [
      ["data/tle/ot.txt", ["OT"]],
      ["data/tle/wfs.txt", ["WFS"]],
      ["data/tle/ot-next.txt", ["OTNext"]],
    ],
  },
};

/**
 * Get configuration preset based on current route/path
 */
export function getConfigPreset(path: string = window.location.pathname): Preset {
  // Extract the last path segment, removing .html extension if present
  const routeName = (path.split("/").pop() ?? "").replace(/\.html$/, "");

  switch (routeName) {
    case "move":
      return presets.move as Preset;
    case "ot":
      return presets.ot as Preset;
    default:
      return presets.default as Preset;
  }
}

/**
 * Update document title and meta description based on preset
 */
export function updateMetadata(preset: Preset): void {
  document.title = preset.title;
  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription && preset.description) {
    metaDescription.setAttribute("content", preset.description);
  }
}

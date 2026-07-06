import { defineStore } from "pinia";

export interface SerializedGroundStation {
  lat: number;
  lon: number;
  name?: string;
}

export interface SatStoreState {
  enabledComponents: string[];
  catalogRevision: number;
  enabledSatellites: string[];
  enabledTags: string[];
  // Names opted out of tag-activation (a satellite unchecked inside an
  // enabled group). Only meaningful while a covering group is enabled.
  disabledSatellites: string[];
  groundStations: SerializedGroundStation[];
  trackedSatellite: string;
  overpassMode: string;
}

export const useSatStore = defineStore("sat", {
  state: (): SatStoreState => ({
    enabledComponents: ["Point", "Label"],
    // Bumped whenever the catalog changes so the UI can recompute catalog
    // queries reactively without putting the ~10k entries into Pinia. Not URL-synced.
    catalogRevision: 0,
    enabledSatellites: [],
    enabledTags: [],
    disabledSatellites: [],
    groundStations: [],
    trackedSatellite: "",
    overpassMode: "elevation",
  }),
  urlsync: {
    enabled: true,
    config: [
      {
        name: "enabledComponents",
        url: "elements",
        serialize: (v) => (v as string[]).join(",").replaceAll(" ", "-"),
        deserialize: (v) =>
          v
            .replaceAll("-", " ")
            .split(",")
            .filter((e) => e),
        default: ["Point", "Label"],
      },
      {
        name: "enabledSatellites",
        url: "sats",
        serialize: (v) => (v as string[]).join(",").replaceAll(" ", "~"),
        deserialize: (v) =>
          v
            .replaceAll("~", " ")
            .split(",")
            .filter((e) => e),
        default: [],
      },
      {
        name: "disabledSatellites",
        url: "xsats",
        serialize: (v) => (v as string[]).join(",").replaceAll(" ", "~"),
        deserialize: (v) =>
          v
            .replaceAll("~", " ")
            .split(",")
            .filter((e) => e),
        default: [],
      },
      {
        name: "enabledTags",
        url: "tags",
        serialize: (v) => (v as string[]).join(",").replaceAll(" ", "-"),
        deserialize: (v) =>
          v
            .replaceAll("-", " ")
            .split(",")
            .filter((e) => e),
        default: [],
      },
      {
        name: "groundStations",
        url: "gs",
        serialize: (v) => (v as SerializedGroundStation[]).map((gs) => `${gs.lat.toFixed(4)},${gs.lon.toFixed(4)}${gs.name ? `,${gs.name}` : ""}`).join("_"),
        deserialize: (v) =>
          v.split("_").map((gs) => {
            const g = gs.split(",");
            // Preserve NaN for missing components; downstream callers filter these out.
            return {
              lat: g[0] === undefined ? Number.NaN : parseFloat(g[0]),
              lon: g[1] === undefined ? Number.NaN : parseFloat(g[1]),
              name: g[2],
            };
          }),
        default: [],
      },
      {
        name: "trackedSatellite",
        url: "track",
        default: "",
      },
      {
        name: "overpassMode",
        url: "overpass",
        default: "elevation",
      },
    ],
  },
});

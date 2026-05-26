import { defineStore } from "pinia";

export interface CesiumStoreState {
  layers: string[];
  terrainProvider: string;
  sceneMode: string;
  cameraMode: string;
  qualityPreset: string;
  background: boolean;
  showFps: boolean;
  pickMode: boolean;
}

export const useCesiumStore = defineStore("cesium", {
  state: (): CesiumStoreState => ({
    layers: ["OfflineHighres"],
    terrainProvider: "None",
    sceneMode: "3D",
    cameraMode: "Fixed",
    qualityPreset: "high",
    background: true,
    showFps: false,
    pickMode: false,
  }),
  urlsync: {
    enabled: true,
    config: [
      {
        name: "layers",
        url: "layers",
        serialize: (v) => (v as string[]).join(","),
        deserialize: (v) => v.split(",").filter((e) => e),
        valid: (v) =>
          (v as string[]).every((l) => ["Offline", "OfflineHighres", "ArcGis", "OSM", "Topo", "BlackMarble", "Tiles", "GOES-IR", "Nextrad"].includes(l.split("_")[0] ?? "")),
        default: ["OfflineHighres"],
      },
      {
        name: "terrainProvider",
        url: "terrain",
        default: "None",
      },
      {
        name: "sceneMode",
        url: "scene",
        default: "3D",
      },
      {
        name: "cameraMode",
        url: "camera",
        default: "Fixed",
      },
      {
        name: "qualityPreset",
        url: "quality",
        default: "high",
      },
      {
        name: "showFps",
        url: "fps",
        default: "false",
      },
      {
        name: "background",
        url: "bg",
        serialize: (v) => `${v}`,
        deserialize: (v) => v === "true",
        default: "true",
      },
    ],
  },
});

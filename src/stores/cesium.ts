import { defineStore } from "pinia";
import { ref } from "vue";

export const useCesiumStore = defineStore(
  "cesium",
  () => {
    const layers = ref<string[]>(["OfflineHighres"]);
    const terrainProvider = ref("None");
    const sceneMode = ref("3D");
    const cameraMode = ref("Fixed");
    const qualityPreset = ref("high");
    const background = ref(true);
    const showFps = ref(false);
    const pickMode = ref(false);

    return {
      layers,
      terrainProvider,
      sceneMode,
      cameraMode,
      qualityPreset,
      background,
      showFps,
      pickMode,
    };
  },
  {
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
  },
);

import { defineStore } from "pinia";
import { ref } from "vue";

import { imageryProviderNames, terrainProviderNames } from "../modules/CesiumLayerProviders";
import { boolean, enumString, layerList } from "../modules/util/urlCodec";

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
    // Wire format: docs/adr/0001-url-parameter-specification.md.
    urlsync: {
      enabled: true,
      config: [
        { name: "layers", url: "layers", kind: layerList(imageryProviderNames) },
        { name: "terrainProvider", url: "terrain", kind: enumString(terrainProviderNames()) },
        { name: "sceneMode", url: "scene", kind: enumString(["3D", "2D", "Columbus"]) },
        { name: "cameraMode", url: "camera", kind: enumString(["Fixed", "Inertial"]) },
        { name: "qualityPreset", url: "quality", kind: enumString(["low", "high"]) },
        { name: "showFps", url: "fps", kind: boolean() },
        { name: "background", url: "bg", kind: boolean() },
      ],
    },
  },
);

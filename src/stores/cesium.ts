import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { baseLayerNames, imageryProviderNames, terrainProviderNames } from "../modules/CesiumLayerProviders";
import { boolean, enumString, layerList, timestamp, toMinuteIso } from "../modules/util/urlCodec";

const providerOf = (layer: string): string => layer.split("_")[0] ?? "";

export const useCesiumStore = defineStore(
  "cesium",
  () => {
    const terrainProvider = ref("None");
    const sceneMode = ref("3D");
    const cameraMode = ref("Fixed");
    const qualityPreset = ref("high");
    const background = ref(true);
    const showFps = ref(false);
    const pickMode = ref(false);

    // Read-only: "at most one base layer" is an invariant of the list as a
    // whole, so it cannot be enforced from a per-checkbox write.
    const activeLayers = ref<string[]>(["OfflineHighres"]);
    const layers = computed(() => activeLayers.value);

    // null means the clock is live and follows the present; a value means it
    // was pinned, by a url or by the user scrubbing the timeline. Read-only so
    // the minute-rounding cannot be skipped — see CONTEXT.md, live vs pinned.
    const pinnedTime = ref<string | null>(null);
    const time = computed(() => pinnedTime.value);

    function setTime(value: string | null): void {
      const next = value === null ? null : (toMinuteIso(value) ?? null);
      if (next !== pinnedTime.value) {
        pinnedTime.value = next;
      }
    }

    /**
     * Commit a layer stack. Unknown providers are dropped, and where several
     * base layers are present the last one wins — that is what picking a new
     * base means. Overlays are always kept; list order is z-order.
     */
    function setLayers(next: readonly string[]): void {
      const known = new Set(imageryProviderNames());
      const bases = new Set(baseLayerNames());
      const valid = next.filter((layer) => known.has(providerOf(layer)));
      const lastBase = valid.reduce((last, layer, index) => (bases.has(providerOf(layer)) ? index : last), -1);
      const resolved = valid.filter((layer, index) => !bases.has(providerOf(layer)) || index === lastBase);

      const unchanged = resolved.length === activeLayers.value.length && resolved.every((layer, index) => layer === activeLayers.value[index]);
      if (!unchanged) {
        activeLayers.value = resolved;
      }
    }

    return {
      layers,
      setLayers,
      time,
      setTime,
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
        { name: "time", url: "time", kind: timestamp() },
      ],
      apply(store, patch) {
        store.setLayers(patch.layers as string[]);
        store.terrainProvider = patch.terrainProvider as string;
        store.sceneMode = patch.sceneMode as string;
        store.cameraMode = patch.cameraMode as string;
        store.qualityPreset = patch.qualityPreset as string;
        store.showFps = patch.showFps as boolean;
        store.background = patch.background as boolean;
        store.setTime(patch.time as string | null);
      },
    },
  },
);

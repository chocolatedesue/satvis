import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { layerProvider } from "../config/layers";
import { SURFACE_MODELS } from "../config/surfaceModels";
import { CAMERA_MODES, SCENE_MODES } from "../config/viewModes";
import { baseLayerNames, imageryProviderNames, terrainProviderNames } from "../modules/CesiumLayerProviders";
import { sameValue } from "../modules/util/equality";
import { boolean, enumString, layerList, timestamp, toMinuteIso } from "../modules/util/urlCodec";

export const useCesiumStore = defineStore(
  "cesium",
  () => {
    const terrainProvider = ref("None");
    // A plain ref, unlike `layers`: at most one is the shape of the value rather
    // than an invariant of a list, so there is nothing to enforce on write. What
    // a selection *implies* is not state — it is derived, in surfaceEffects.
    const surfaceModel = ref("None");
    const sceneMode = ref("3D");
    const cameraMode = ref("Fixed");
    const qualityPreset = ref("high");
    const background = ref(true);
    const showFps = ref(false);
    const pickMode = ref(false);
    // PROTOTYPE: the benchmarking framework (src/modules/benchmark). URL-synced
    // like every other debug toggle, so a benchmarking session is a shareable
    // link and the switch in the menu and the `?bench` parameter are one thing
    // rather than two ways in.
    const showBenchmark = ref(false);

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
      // A layer with an unusable opacity is no more storable than an unknown
      // provider — it would reach Cesium as NaN and render nothing.
      const valid = next.filter((layer) => {
        const provider = layerProvider(layer);
        return provider !== undefined && known.has(provider);
      });
      const isBase = (layer: string) => bases.has(layerProvider(layer) ?? "");
      const lastBase = valid.reduce((last, layer, index) => (isBase(layer) ? index : last), -1);
      const resolved = valid.filter((layer, index) => !isBase(layer) || index === lastBase);

      if (!sameValue(resolved, activeLayers.value)) {
        activeLayers.value = resolved;
      }
    }

    return {
      layers,
      setLayers,
      time,
      setTime,
      terrainProvider,
      surfaceModel,
      sceneMode,
      cameraMode,
      qualityPreset,
      background,
      showFps,
      pickMode,
      showBenchmark,
    };
  },
  {
    // Wire format: docs/adr/0001-url-parameter-specification.md.
    urlsync: {
      enabled: true,
      config: [
        { name: "layers", url: "layers", kind: layerList(imageryProviderNames) },
        { name: "terrainProvider", url: "terrain", kind: enumString(terrainProviderNames()) },
        { name: "surfaceModel", url: "surface", kind: enumString(SURFACE_MODELS) },
        { name: "sceneMode", url: "scene", kind: enumString(SCENE_MODES) },
        { name: "cameraMode", url: "camera", kind: enumString(CAMERA_MODES) },
        { name: "qualityPreset", url: "quality", kind: enumString(["low", "high"]) },
        { name: "showFps", url: "fps", kind: boolean() },
        { name: "showBenchmark", url: "bench", kind: boolean() },
        { name: "background", url: "bg", kind: boolean() },
        { name: "time", url: "time", kind: timestamp() },
      ],
      // Only the guarded keys are named; everything else is a plain ref.
      apply(store, patch) {
        const { layers, time, ...free } = patch;
        Object.assign(store, free);
        store.setLayers(layers as string[]);
        store.setTime(time as string | null);
      },
    },
  },
);

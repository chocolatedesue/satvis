// The one place store state becomes globe state.
//
// This used to be fourteen watchers inside Satvis.vue, which had to be an
// always-mounted component for them to survive the catalog panel closing, and
// which quietly made "EntityInfoPanel is a child of Satvis" load-bearing —
// useSelectedEntity depended on being registered after Satvis's overpassMode
// watcher. Started from app.ts instead, none of that matters.
//
// The direction is one-way. The store decides, Cesium follows. The only value
// that also travels the other way is tracking, because the user can start it by
// clicking a satellite on the globe, and that arrives as a callback.

import { watch } from "vue";

import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import type { CesiumController } from "./CesiumController";
import type { DesiredScene } from "./SatelliteManager";

export function startSceneSync(cc: CesiumController): void {
  const cesiumStore = useCesiumStore();
  const satStore = useSatStore();

  // --- globe settings -------------------------------------------------------
  watch(
    () => cesiumStore.layers,
    (layers) => {
      cc.imageryLayers = [...layers];
    },
    { deep: true },
  );
  watch(
    () => cesiumStore.terrainProvider,
    (name) => {
      cc.terrainProvider = name;
    },
  );
  watch(
    () => cesiumStore.sceneMode,
    (mode) => {
      cc.sceneMode = mode;
    },
  );
  watch(
    () => cesiumStore.cameraMode,
    (mode) => {
      cc.cameraMode = mode;
    },
  );
  watch(
    () => cesiumStore.qualityPreset,
    (preset) => {
      cc.qualityPreset = preset;
    },
    { immediate: true },
  );
  watch(
    () => cesiumStore.showFps,
    (show) => {
      cc.showFps = show;
    },
  );
  watch(
    () => cesiumStore.background,
    (on) => {
      cc.background = on;
    },
  );

  // --- the scene ------------------------------------------------------------
  const desired = (): DesiredScene => ({
    tags: [...satStore.enabledTags],
    satellites: [...satStore.enabledSatellites],
    excluded: [...satStore.disabledSatellites],
    components: [...satStore.enabledComponents],
    groundStations: satStore.groundStations.map((station) => ({ ...station })),
    overpassMode: satStore.overpassMode,
    tracked: satStore.trackedSatellite,
  });

  watch(desired, (next) => cc.sats.reconcile(next), { deep: true, immediate: true });

  // --- back from the globe --------------------------------------------------
  cc.sats.onTrackedChange((name) => {
    satStore.trackedSatellite = name;
  });

  // The catalog is deliberately non-reactive — ~10k entries do not belong in
  // Pinia — so a revision counter is what lets catalog-derived views recompute.
  cc.sats.onCatalogChange(() => {
    satStore.catalogRevision += 1;
  });
}

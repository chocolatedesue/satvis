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

import { JulianDate } from "@cesium/engine";
import { watch } from "vue";

import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import type { CesiumController } from "./CesiumController";
import type { DesiredScene } from "./SatelliteManager";
import { toMinuteIso } from "./util/urlCodec";

// Enough to keep a fast clock multiplier from hammering the history api.
const MIN_CLOCK_WRITE_MS = 1000;

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
    enabledTags: [...satStore.enabledTags],
    enabledSatellites: [...satStore.enabledSatellites],
    disabledSatellites: [...satStore.disabledSatellites],
    components: [...satStore.enabledComponents],
    groundStations: satStore.groundStations.map((station) => ({ ...station })),
    overpassMode: satStore.overpassMode,
    trackedSatellite: satStore.trackedSatellite,
  });

  watch(desired, (next) => cc.sats.reconcile(next), { deep: true, immediate: true });

  // --- the clock ------------------------------------------------------------
  // Live by default: `time` is null and absent from the url, so a shared link
  // opens at the recipient's present. It pins on a deliberate act — a time in
  // the url, or the user dragging the timeline — and then follows the clock at
  // minute granularity so the link reproduces the moment being looked at.
  const clockMinute = (): string | undefined => toMinuteIso(JulianDate.toDate(cc.viewer.clock.currentTime));

  watch(
    () => cesiumStore.time,
    (pinned) => {
      if (pinned !== null && pinned !== (clockMinute() ?? null)) {
        cc.setTime(pinned);
      }
    },
    { immediate: true },
  );

  let lastClockWrite = 0;
  cc.viewer.clock.onTick.addEventListener(() => {
    if (cesiumStore.time === null) {
      return;
    }
    const now = performance.now();
    if (now - lastClockWrite < MIN_CLOCK_WRITE_MS) {
      return;
    }
    const minute = clockMinute();
    if (minute === cesiumStore.time) {
      return;
    }
    lastClockWrite = now;
    cesiumStore.setTime(minute ?? null);
  });

  // Dragging the timeline is the other way in. Cesium's Timeline dispatches
  // this on its own element; it is absent in minimal ui, where there is no
  // timeline to drag.
  // Cesium dispatches this from Timeline.prototype._setTimeBarTime but does not
  // declare addEventListener on the widget, so the cast covers a typing gap
  // rather than an assumption.
  const timeline = cc.viewer.timeline as unknown as { addEventListener?: (type: string, listener: () => void) => void } | undefined;
  timeline?.addEventListener?.("settime", () => {
    cesiumStore.setTime(clockMinute() ?? null);
  });

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

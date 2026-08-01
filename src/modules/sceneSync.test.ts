// What crosses the store→globe seam.
//
// This file could not exist before `startSceneSync` took a `SceneTarget`: its
// argument was `CesiumController`, whose constructor called
// `new Viewer("cesiumContainer", …)`, so there was no way to reach any of this
// without a WebGL context. The fake below is the whole of what sceneSync needs,
// which is also the point of declaring the interface.

import { JulianDate } from "@cesium/engine";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";

import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import type { DesiredScene } from "./SatelliteManager";
import { type SceneTarget, startSceneSync } from "./sceneSync";
import type { Observer } from "./SkyView";

// Only the probe is stubbed — it is a network read, and nothing here is about
// the imagery fallback. The registry the store builds its url schema from is the
// real one.
vi.mock(import("./CesiumLayerProviders"), async (importOriginal) => ({
  ...(await importOriginal()),
  highresImageryMissing: () => Promise.resolve(false),
  withoutHighresImagery: () => undefined,
}));

/** Everything sceneSync writes to, recorded rather than enacted. */
function fakeTarget() {
  const calls = {
    morphedTo: [] as string[],
    entered: [] as Observer[],
    exits: 0,
    interactionStarts: 0,
    interactionStops: 0,
    suppressCamera: 0,
    releaseCamera: 0,
    reconciled: [] as DesiredScene[],
    surfaceModels: [] as [string, string][],
  };

  const target: SceneTarget & { skyView: { active: boolean } } = {
    imageryLayers: [],
    terrainProvider: "None",
    cameraMode: "Fixed",
    qualityPreset: "",
    showFps: false,
    background: false,
    skyView: {
      active: false,
      enter(observer: Observer) {
        calls.entered.push(observer);
        this.active = true;
        return Promise.resolve();
      },
      exit() {
        calls.exits += 1;
        this.active = false;
        return Promise.resolve();
      },
    },
    skyInteraction: {
      start: () => {
        calls.interactionStarts += 1;
      },
      stop: () => {
        calls.interactionStops += 1;
      },
    },
    sats: {
      reconcile: (desired) => {
        calls.reconciled.push(desired);
      },
      onTrackedChange: () => {},
      onCatalogChange: () => {},
    },
    viewer: {
      clock: {
        currentTime: JulianDate.fromIso8601("2026-01-01T00:00:00Z"),
        onTick: { addEventListener: () => () => {} },
      },
      timeline: undefined,
    },
    applySurfaceModel: (surfaceModel, viewMode) => {
      calls.surfaceModels.push([surfaceModel, viewMode]);
      return Promise.resolve();
    },
    suppressCameraMode: () => {
      calls.suppressCamera += 1;
    },
    releaseCameraMode: () => {
      calls.releaseCamera += 1;
    },
    morphTo: (mode) => {
      calls.morphedTo.push(mode);
    },
    setTime: () => {},
  };

  return { target, calls };
}

/** Two ticks: the watcher runs on one, the awaited view-mode work on the next. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await nextTick();
  }
}

describe("startSceneSync", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("plain settings travel from the store to the globe", async () => {
    const { target } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    store.terrainProvider = "CesiumWorldTerrain";
    store.cameraMode = "Inertial";
    store.showFps = true;
    store.background = false;
    await nextTick();

    expect(target.terrainProvider).toBe("CesiumWorldTerrain");
    expect(target.cameraMode).toBe("Inertial");
    expect(target.showFps).toBe(true);
  });

  test("a projection view mode morphs, and hands the camera back first", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    store.sceneMode = "2D";
    await settle();

    expect(calls.morphedTo).toEqual(["2D"]);
    // The flight home has to land before the projection changes underneath it.
    expect(calls.exits).toBe(1);
    expect(calls.releaseCamera).toBe(1);
  });

  test("the sky view enters on the first ground station, and takes the camera", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const cesiumStore = useCesiumStore();
    const satStore = useSatStore();

    satStore.setGroundStations([{ lat: 48.1, lon: 11.6, name: "Munich" }]);
    cesiumStore.sceneMode = "Sky";
    await settle();

    expect(calls.entered).toEqual([{ lat: 48.1, lon: 11.6 }]);
    // Suppressed rather than cleared, so `?camera=Inertial` survives the trip.
    expect(calls.suppressCamera).toBe(1);
    expect(calls.interactionStarts).toBe(1);
    expect(cesiumStore.sceneMode).toBe("Sky");
  });

  test("with no observer available the sky view is refused and the mode goes back", async () => {
    // No ground station, and a device that declines to say where it is.
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error("denied")) } });
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    store.sceneMode = "Sky";
    await settle();

    expect(calls.entered).toEqual([]);
    expect(store.sceneMode).toBe("3D");
    vi.unstubAllGlobals();
  });

  test("nothing stays tracked while the sky view is up", async () => {
    const { target } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();
    target.skyView.active = true;

    satStore.trackedSatellite = "ISS";
    await nextTick();

    expect(satStore.trackedSatellite).toBe("");
  });

  test("the desired scene is handed over as plain data", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();

    satStore.setActivation({ enabledTags: ["Weather"], enabledSatellites: ["ISS"] });
    await settle();

    const last = calls.reconciled.at(-1);
    expect(last?.enabledTags).toEqual(["Weather"]);
    expect(last?.enabledSatellites).toEqual(["ISS"]);
    // Copies, not the store's own arrays: the manager diffs against what it was
    // last given, and a live reference would compare equal to itself.
    expect(last?.enabledTags).not.toBe(satStore.enabledTags);
  });
});

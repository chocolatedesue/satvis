// What a demo scene puts on screen. These exist because the failure was visual and
// silent: the scenes kept the route's own activation alongside their own, so the
// default preset's `Weather` group stayed layered under the handful of generated
// satellites the demo is about. Nothing threw, no count was wrong, and the globe
// simply filled with catalogued satellites labelled by their full names.
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp, markRaw } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import { applyMigrationScene, applySunSyncScene, applyTwoOrbitScene, type ClockControl, DEMO_MULTIPLIER } from "./demoScenes";
import { isWalkerTag } from "./util/walkerDelta";

/** Records what the scene did to the clock, which is not store state. */
function clockSpy(): ClockControl & { multiplier?: number; played: boolean } {
  const spy = {
    played: false,
    multiplier: undefined as number | undefined,
    setMultiplier(value: number) {
      spy.multiplier = value;
    },
    play() {
      spy.played = true;
    },
  };
  return spy;
}

/** A store pair with the default route's activation already in place. */
function stores() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: {} }] });
  const pinia = createPinia();
  pinia.use(({ store }) => {
    store.router = markRaw(router);
    store.customConfig = markRaw({});
  });
  createApp({}).use(pinia);
  setActivePinia(pinia);
  const satStore = useSatStore();
  // What the default preset leaves behind, and what a demo used to keep.
  satStore.setActivation({ enabledTags: ["Weather"], enabledSatellites: ["ISS (ZARYA)"], disabledSatellites: ["NOAA 19"] });
  return { satStore, cesiumStore: useCesiumStore() };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("demo scenes", () => {
  const cases = [
    { name: "two-orbit", apply: (s: ReturnType<typeof stores>, c: ClockControl) => applyTwoOrbitScene(s.satStore, s.cesiumStore, c), patterns: 1 },
    { name: "migration", apply: (s: ReturnType<typeof stores>, c: ClockControl) => applyMigrationScene(s.satStore, s.cesiumStore, c), patterns: 1 },
    { name: "sso", apply: (s: ReturnType<typeof stores>, c: ClockControl) => applySunSyncScene(s.satStore, s.cesiumStore, c, 1760), patterns: 2 },
  ];

  for (const { name, apply, patterns } of cases) {
    describe(name, () => {
      test("shows only the patterns it generates", () => {
        const s = stores();
        apply(s, clockSpy());
        expect(s.satStore.enabledTags).toHaveLength(patterns);
        expect(s.satStore.enabledTags.every((tag) => isWalkerTag(tag))).toBe(true);
        expect(s.satStore.walker).toHaveLength(patterns);
      });

      // An individually enabled satellite outlives a tag change, so clearing the tags
      // is not enough on its own — the catalogued satellite would still be drawn.
      test("drops activation carried in by name", () => {
        const s = stores();
        apply(s, clockSpy());
        expect(s.satStore.enabledSatellites).toEqual([]);
        expect(s.satStore.disabledSatellites).toEqual([]);
      });

      test("sets up the illumination view and runs the clock", () => {
        const s = stores();
        const clock = clockSpy();
        apply(s, clock);
        expect(s.satStore.pointColorMode).toBe("illumination");
        expect(s.satStore.enabledComponents).toContain("Illumination arc");
        expect(s.cesiumStore.cameraMode).toBe("Inertial");
        expect(clock.multiplier).toBe(DEMO_MULTIPLIER);
        expect(clock.played).toBe(true);
      });
    });
  }

  test("only the migration demo turns the overlay on", () => {
    const twoOrbit = stores();
    applyTwoOrbitScene(twoOrbit.satStore, twoOrbit.cesiumStore, clockSpy());
    expect(twoOrbit.satStore.migration).toBe(false);

    const migration = stores();
    applyMigrationScene(migration.satStore, migration.cesiumStore, clockSpy());
    expect(migration.satStore.migration).toBe(true);
  });

  test("the sso demo's two orbits differ only in their node", () => {
    const s = stores();
    applySunSyncScene(s.satStore, s.cesiumStore, clockSpy(), 1760);
    const [a, b] = s.satStore.walker as [string, string];
    expect(a.split("+")[0]).toBe(b.split("+")[0]);
    expect(a).not.toBe(b);
    // The panel axis is what makes the eclipse difference legible at all.
    expect(s.satStore.panelAxis).toBe("normal");
  });
});

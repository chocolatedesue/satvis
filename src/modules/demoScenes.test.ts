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
import { applyMigrationScene, applyShellsScene, applySunSyncScene, applyTwoOrbitScene, type ClockControl, DEMO_MULTIPLIER, SHELLS_MULTIPLIER } from "./demoScenes";
import { decodeWalker, isWalkerTag } from "./util/walkerDelta";

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

  describe("shells", () => {
    function applyShells() {
      const s = stores();
      const clock = clockSpy();
      applyShellsScene(s.satStore, s.cesiumStore, clock);
      return { s, clock };
    }

    test("stacks three distinct patterns and shows only them", () => {
      const { s } = applyShells();
      expect(s.satStore.walker).toHaveLength(3);
      expect(new Set(s.satStore.walker).size).toBe(3);
      expect(s.satStore.enabledTags).toHaveLength(3);
      expect(s.satStore.enabledTags.every((tag) => isWalkerTag(tag))).toBe(true);
      expect(s.satStore.enabledSatellites).toEqual([]);
    });

    test("every pair differs in a way relative motion can answer for", () => {
      const { s } = applyShells();
      const shells = (s.satStore.walker as string[]).map((wire) => decodeWalker(wire)!);
      // Two distinct altitudes: the low shell laps the high ones through the
      // period difference.
      expect(new Set(shells.map((shell) => shell.altitudeKm)).size).toBe(2);
      // Three distinct inclinations: the two same-period high shells differ in
      // node precession instead, which is the slow seam drift the demo exists to
      // show.
      expect(new Set(shells.map((shell) => shell.inclinationDeg)).size).toBe(3);
    });

    test("runs the clock at the shells multiplier, not the demo one", () => {
      const { clock } = applyShells();
      expect(clock.multiplier).toBe(SHELLS_MULTIPLIER);
      expect(clock.multiplier).not.toBe(DEMO_MULTIPLIER);
      expect(clock.played).toBe(true);
    });

    test("keeps the illumination view and the inertial frame", () => {
      const { s } = applyShells();
      expect(s.satStore.pointColorMode).toBe("illumination");
      expect(s.satStore.enabledComponents).toContain("Illumination arc");
      expect(s.cesiumStore.cameraMode).toBe("Inertial");
    });

    test("turns the link overlay on", () => {
      const { s } = applyShells();
      expect(s.satStore.links).toBe(true);
    });

    test("marks one satellite per shell as the cross-shell sample", () => {
      const { s } = applyShells();
      expect(s.satStore.marks).toHaveLength(3);
      for (const token of s.satStore.marks as string[]) {
        expect(token).toMatch(/^1-1@/);
        expect(s.satStore.walker).toContain(token.split("@").slice(1).join("@"));
      }
    });

    test("flies the low shell dense enough for its ring links to clear the Earth", () => {
      const { s } = applyShells();
      const low = (s.satStore.walker as string[]).map((wire) => decodeWalker(wire)!).find((shell) => shell.altitudeKm === 550);
      expect(low).toBeDefined();
      // a·cos(π/S) > R: at 550 km the derivation asks for S ≥ 8 per plane.
      expect(Math.round(low!.total / low!.planes)).toBeGreaterThanOrEqual(8);
    });
  });
});

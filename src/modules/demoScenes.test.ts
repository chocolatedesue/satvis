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
import {
  applyClusterScene,
  applyFamilyScene,
  applyMigrationScene,
  applyShellsScene,
  applyStableShellsScene,
  applySunSyncScene,
  applyTwoOrbitScene,
  applyWalker25Scene,
  type ClockControl,
  CLUSTER_MULTIPLIER,
  DEMO_MULTIPLIER,
  FAMILY_BAND_KM,
  SHELLS_MULTIPLIER,
  STABLE_REFERENCE,
  WALKER25_PARAMS,
} from "./demoScenes";
import { CLUSTER_EPOCH_ISO, clusterFormationRecords, clusterNamePrefix, clusterRadiusM, clusterTagFor, decodeCluster } from "./util/clusterFormation";
import { parseGeneratedSatellite, resolveMarks } from "./util/constellationLinks";
import { shellPairLayout, shellRates } from "./util/shellLayout";
import { SUN_DEG_PER_DAY } from "./util/sunSynchronous";
import { decodeWalker, encodeWalker, isWalkerTag, satsPerPlane, walkerTagFor, type WalkerDeltaParams } from "./util/walkerDelta";

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

  describe("stable shells", () => {
    function applyStable() {
      const s = stores();
      const clock = clockSpy();
      applyStableShellsScene(s.satStore, s.cesiumStore, clock);
      return { s, clock };
    }

    test("flies the reference, a designed companion and a control", () => {
      const { s } = applyStable();
      expect(s.satStore.walker).toHaveLength(3);
      expect(s.satStore.walker[0]).toBe(encodeWalker(STABLE_REFERENCE));
      expect(s.satStore.enabledTags.every((tag) => isWalkerTag(tag))).toBe(true);
    });

    test("the companion is node-locked and resonant; the control is neither", () => {
      const { s } = applyStable();
      const [reference, companion, control] = (s.satStore.walker as string[]).map((wire) => decodeWalker(wire)!);
      expect(shellPairLayout(reference!, companion!).verdict).toBe("repeating");
      expect(shellPairLayout(reference!, control!).verdict).toBe("drifting");
      // The whole point of the pairing: same altitude band, opposite verdicts.
      expect(Math.abs(companion!.altitudeKm - control!.altitudeKm)).toBeLessThan(50);
    });

    test("the repeat cycle is the one the derivation quotes", () => {
      const { s } = applyStable();
      const [reference, companion] = (s.satStore.walker as string[]).map((wire) => decodeWalker(wire)!);
      const resonance = shellPairLayout(reference!, companion!).resonance;
      expect(resonance).toMatchObject({ referenceRevolutions: 8, companionRevolutions: 7 });
      expect(resonance!.repeatHours).toBeCloseTo(12.7, 1);
    });

    test("marks one satellite per shell, so the two verdicts are drawn side by side", () => {
      const { s } = applyStable();
      expect(s.satStore.marks).toHaveLength(3);
      expect(s.satStore.links).toBe(true);
    });

    test("runs at the shells multiplier, which puts a repeat cycle at about 76 s", () => {
      const { clock } = applyStable();
      expect(clock.multiplier).toBe(SHELLS_MULTIPLIER);
      expect(clock.played).toBe(true);
    });
  });
});

describe("walker25", () => {
  function applyWalker25() {
    const s = stores();
    const clock = clockSpy();
    applyWalker25Scene(s.satStore, s.cesiumStore, clock);
    return { s, clock };
  }

  test("keeps all 25 planes and densifies each to ten satellites", () => {
    // The 25 planes are the scene's point — 14.4° of RAAN apart, so one is always
    // crossing into shadow. The count per plane was four, which put same-plane
    // neighbours 90° apart and read as a sparse dotted orbit; ten (36° apart) is
    // the density fix, and the scene's own constant is what the panel drafts into
    // its form so the two cannot drift.
    const { s } = applyWalker25();
    expect(WALKER25_PARAMS).toEqual({ total: 250, planes: 25, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 });
    expect(s.satStore.walker).toEqual([encodeWalker(WALKER25_PARAMS)]);
    const params = decodeWalker(s.satStore.walker[0]!)!;
    expect(params.planes).toBe(25);
    expect(satsPerPlane(params)).toBe(10);
    expect(params.total).toBe(250);
    // Same-plane angular spacing is 360°/S, and the report asked for at most 45°.
    expect(360 / satsPerPlane(params)).toBeLessThanOrEqual(45);
  });

  test("shows only the pattern, in the illumination view, with the overlays on", () => {
    const { s, clock } = applyWalker25();
    expect(s.satStore.enabledTags).toEqual([walkerTagFor(WALKER25_PARAMS)]);
    expect(s.satStore.enabledSatellites).toEqual([]);
    expect(s.satStore.pointColorMode).toBe("illumination");
    // The arc is the orbit ring the scene leans on to make the two halves of a
    // projected orbit read as one loop — the readability answer to the
    // "opposite directions" report.
    expect(s.satStore.enabledComponents).toContain("Illumination arc");
    expect(s.cesiumStore.cameraMode).toBe("Inertial");
    // The topology overlay and the migration overlay are both part of the scene.
    expect(s.satStore.links).toBe(true);
    expect(s.satStore.migration).toBe(true);
    expect(clock.multiplier).toBe(DEMO_MULTIPLIER);
    expect(clock.played).toBe(true);
  });
});

describe("sso family", () => {
  function applyFamily() {
    const s = stores();
    const clock = clockSpy();
    applyFamilyScene(s.satStore, s.cesiumStore, clock);
    return { s, clock };
  }

  function shellsOf(s: ReturnType<typeof stores>): WalkerDeltaParams[] {
    return (s.satStore.walker as string[]).map((wire) => decodeWalker(wire)!);
  }

  test("flies a whole family, and shows only it", () => {
    const { s } = applyFamily();
    expect(s.satStore.walker.length).toBeGreaterThanOrEqual(3);
    expect(s.satStore.enabledTags).toHaveLength(s.satStore.walker.length);
    expect(s.satStore.enabledTags.every((tag) => isWalkerTag(tag))).toBe(true);
    expect(s.satStore.enabledSatellites).toEqual([]);
  });

  test("every pair in the family returns — the claim a family makes", () => {
    // A family is written forwards rather than searched for: fix the reference's
    // revolutions per cycle and every other whole number in the band names one
    // more node-locked shell, so every *pair* among them closes by construction.
    // No pair of distinct shells can be rigid, so repeating is the ceiling here.
    const { s } = applyFamily();
    const shells = shellsOf(s);
    for (let a = 0; a < shells.length; a += 1) {
      for (let b = a + 1; b < shells.length; b += 1) {
        expect(shellPairLayout(shells[a]!, shells[b]!).verdict).toBe("repeating");
      }
    }
  });

  test("every member is sun-synchronous, because every member is node-locked to one", () => {
    // The reason this family is worth flying rather than merely possible: the
    // node rate a member inherits is the reference's, which is the sun's own, so
    // sun-synchrony is a consequence of the lock and not something each shell is
    // designed for separately. A drifting shell sits degrees per day away.
    const { s } = applyFamily();
    for (const shell of shellsOf(s)) {
      expect(shellRates(shell).nodeRateDegPerDay).toBeCloseTo(SUN_DEG_PER_DAY, 1);
    }
  });

  test("spreads across the band rather than stacking up in one corner of it", () => {
    const { s } = applyFamily();
    const shells = shellsOf(s);
    const altitudes = shells.map((shell) => shell.altitudeKm);
    expect(new Set(altitudes).size).toBe(altitudes.length);
    for (const altitudeKm of altitudes) {
      expect(altitudeKm).toBeGreaterThanOrEqual(FAMILY_BAND_KM.min);
      expect(altitudeKm).toBeLessThanOrEqual(FAMILY_BAND_KM.max);
    }
    // Node-locking costs inclination, and this is the bill: a handful of degrees
    // across the whole family, which is the lever the near-polar reference buys.
    const inclinations = shells.map((shell) => shell.inclinationDeg);
    expect(Math.max(...inclinations) - Math.min(...inclinations)).toBeLessThan(15);
  });

  test("marks one satellite per shell and runs at the shells multiplier", () => {
    const { s, clock } = applyFamily();
    expect(s.satStore.marks).toHaveLength(s.satStore.walker.length);
    expect(s.satStore.links).toBe(true);
    expect(clock.multiplier).toBe(SHELLS_MULTIPLIER);
    expect(clock.played).toBe(true);
  });
});

describe("cluster", () => {
  test("draws one formation, at a size a globe can resolve", () => {
    const s = stores();
    applyClusterScene(s.satStore, s.cesiumStore, clockSpy());

    expect(s.satStore.cluster).toHaveLength(1);
    const params = decodeCluster(s.satStore.cluster[0]!)!;
    expect(params).toBeDefined();
    // The whole point of the preset choice: Suncatcher's own kilometre is one
    // point at globe range, so the scene flies the same lattice blown up.
    expect(clusterRadiusM(params)).toBeGreaterThan(50_000);
    expect(s.satStore.enabledTags).toEqual([clusterTagFor(params)]);
    expect(s.satStore.walker).toEqual([]);
  });

  test("marks the reference and its eight neighbours, not the whole lattice", () => {
    // Every marked pair is bonded, so marking all 29 members would draw 406 lines
    // inside a 240 km box — a thicket rather than a cluster. Nine is the set
    // Google's own figure picks out in magenta, and 36 bonds.
    const s = stores();
    applyClusterScene(s.satStore, s.cesiumStore, clockSpy());

    expect(s.satStore.marks).toHaveLength(9);
    expect(new Set(s.satStore.marks).size).toBe(9);
    expect(s.satStore.links).toBe(true);
  });

  test("resolves each mark against a satellite the scene actually generates", () => {
    // A token that names nothing draws nothing and says so nowhere, so the
    // lattice-index shift is worth pinning against the generator itself.
    const s = stores();
    applyClusterScene(s.satStore, s.cesiumStore, clockSpy());
    const params = decodeCluster(s.satStore.cluster[0]!)!;
    const names = new Set(
      clusterFormationRecords(params, new Date(CLUSTER_EPOCH_ISO), clusterNamePrefix(params)).flatMap((record) => (record.kind === "omm" ? [record.omm.OBJECT_NAME] : [])),
    );
    const endpoints = [...names].flatMap((name) => parseGeneratedSatellite(name) ?? []);

    const { members, bonds } = resolveMarks(s.satStore.marks, endpoints);
    expect(names.size).toBeGreaterThan(s.satStore.marks.length);
    expect(members).toHaveLength(s.satStore.marks.length);
    expect(bonds.every((bond) => bond.verdict === "rigid" && bond.returns)).toBe(true);
  });

  test("asks for the arc rather than the plain orbit, and runs the clock fast enough to see the shape cycle", () => {
    // The arc is the orbit line coloured, and the manager suppresses the plain
    // one while the arc is on so they do not z-fight on identical geometry.
    // Asking for both is asking for one to be ignored.
    const s = stores();
    const clock = clockSpy();
    applyClusterScene(s.satStore, s.cesiumStore, clock);

    expect(s.satStore.enabledComponents).toContain("Illumination arc");
    expect(s.satStore.enabledComponents).not.toContain("Orbit");
    expect(s.cesiumStore.cameraMode).toBe("Inertial");
    expect(clock.multiplier).toBe(CLUSTER_MULTIPLIER);
    expect(clock.played).toBe(true);
  });
});

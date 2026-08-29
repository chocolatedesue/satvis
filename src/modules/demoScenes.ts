// The demo scenes, in one place so a button in the panel and a `?demo=` link on
// startup set up exactly the same thing.
//
// They were methods inside OrbitLabPanel.vue, which meant the only way to reach
// them was to open the panel and click — a shared link could carry the scene's
// store state (the walker pattern, the colouring, the camera) but not the one
// piece that is live viewer state and not in the url: the clock rate. Without it
// a shared migration link opens frozen at 1×, where nothing migrates for half an
// orbit. Pulling the scene out here lets app.ts run it from the url before any
// panel mounts, clock and all.
//
// The store writes are what the url already round-trips; the clock is the extra,
// handed in as a tiny control so the panel can drive it through useViewerClock
// and the startup path can drive the ClockViewModel directly.

import type { useCesiumStore } from "../stores/cesium";
import type { useSatStore } from "../stores/sat";
import { sunSyncWalkerParams } from "./util/sunSynchronous";
import { encodeWalker, WALKER_EPOCH_ISO, WALKER_PRESETS, walkerTagFor } from "./util/walkerDelta";

type SatStore = ReturnType<typeof useSatStore>;
type CesiumStore = ReturnType<typeof useCesiumStore>;

/** The clock, reduced to what a demo needs of it. */
export interface ClockControl {
  setMultiplier(value: number): void;
  play(): void;
}

/**
 * How fast the demos run the clock.
 *
 * A 550 km orbit is 95.6 minutes; at 1× the illumination story is a still frame.
 * 60× puts an orbit at about a minute and a half — slow enough to follow one
 * satellite, fast enough that the eclipse crossing (and, in the migration demo,
 * the hop it triggers) arrives while someone is still looking.
 */
export const DEMO_MULTIPLIER = 60;

/** The names `?demo=` understands. */
export const DEMO_NAMES = ["two-orbit", "sso", "migration"] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

function withIlluminationComponents(satStore: SatStore): void {
  // Labels are on: a generated satellite is labelled by its plane and slot (`P01-07`,
  // six characters — see SatelliteComponentCollection.createLabel), which is what makes
  // "which satellite is that" answerable from the picture rather than only from the
  // migration table. They were suppressed here while the label was the satellite's full
  // name, where twenty repetitions of the same pattern prefix were noise rather than
  // labels.
  const components = new Set([...satStore.enabledComponents, "Point", "Illumination arc", "Label"]);
  satStore.enabledComponents = [...components];
}

/**
 * Show exactly the patterns a demo generates, and nothing else.
 *
 * Every demo is a scene, and a scene says what is on screen as much as it says how
 * it is drawn — it already overrides the colouring, the point size, the camera and
 * the clock. Leaving the route's own activation in place alongside meant the default
 * preset's `Weather` group — 73 real satellites — stayed layered under the handful
 * the demo is about. That was tolerable while labels were off. It stopped being so
 * once labels went on: a generated satellite labels as `P01-07`, but a catalogued
 * one falls back to its full name, so the globe filled with overlapping
 * `HIMAWARI-8` / `TIANMU-1 21` / `DMSP 5D-3 F17 (USA 191)` and the two planes the
 * scene exists to show were the hardest thing on it to find.
 *
 * The migration demo always did this narrowing for its own reasons; the other two
 * wanted it just as much and did not say so.
 */
function showOnly(satStore: SatStore, tags: string[]): void {
  satStore.setActivation({ enabledTags: tags, enabledSatellites: [], disabledSatellites: [] });
}

/**
 * Two orbital planes 90° apart, ten satellites each, coloured by illumination and
 * watched in the inertial frame with the clock moving. The simplest scene the
 * orbit lab exists to show.
 */
export function applyTwoOrbitScene(satStore: SatStore, cesiumStore: CesiumStore, clock: ClockControl): void {
  const preset = WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number];
  satStore.walker = [encodeWalker(preset.params)];
  satStore.pointColorMode = "illumination";
  satStore.pointSize = "large";
  withIlluminationComponents(satStore);
  showOnly(satStore, [walkerTagFor(preset.params)]);
  cesiumStore.cameraMode = "Inertial";
  clock.setMultiplier(DEMO_MULTIPLIER);
  clock.play();
}

/**
 * The two-orbit scene plus the naive KV-cache migration overlay, over exactly the
 * satellites it hops between.
 */
export function applyMigrationScene(satStore: SatStore, cesiumStore: CesiumStore, clock: ClockControl): void {
  applyTwoOrbitScene(satStore, cesiumStore, clock);
  satStore.migration = true;
}

/**
 * The same orbit twice a quarter-turn of the plane apart — one dawn–dusk, one
 * noon–midnight — so "never eclipsed" has something eclipsed to stand against.
 */
export function applySunSyncScene(satStore: SatStore, cesiumStore: CesiumStore, clock: ClockControl, altitudeKm: number): void {
  const epoch = new Date(WALKER_EPOCH_ISO);
  const dawnDusk = sunSyncWalkerParams({ altitudeKm, total: 12, plane: "dawn-dusk" }, epoch);
  const noonMidnight = sunSyncWalkerParams({ altitudeKm, total: 12, plane: "noon-midnight" }, epoch);
  if (!dawnDusk || !noonMidnight) {
    return;
  }
  satStore.walker = [encodeWalker(dawnDusk), encodeWalker(noonMidnight)];
  satStore.pointColorMode = "illumination";
  satStore.pointSize = "large";
  // The orbit normal, not the zenith: a dawn–dusk plane sits nearly face-on to the
  // sun, so a zenith panel is edge-on all the way round and every satellite reads
  // sunlit_edge — which buries the eclipse story this demo is about.
  satStore.panelAxis = "normal";
  withIlluminationComponents(satStore);
  showOnly(satStore, [walkerTagFor(dawnDusk), walkerTagFor(noonMidnight)]);
  cesiumStore.cameraMode = "Inertial";
  clock.setMultiplier(DEMO_MULTIPLIER);
  clock.play();
}

/** Whether a string is a demo `?demo=` understands. */
export function isDemoName(value: string | null | undefined): value is DemoName {
  return value != null && (DEMO_NAMES as readonly string[]).includes(value);
}

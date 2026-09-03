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
import { resonantCompanion } from "./util/shellLayout";
import { sunSyncWalkerParams } from "./util/sunSynchronous";
import { encodeWalker, WALKER_EPOCH_ISO, WALKER_PRESETS, walkerPatternAt, walkerTagFor, type WalkerDeltaParams } from "./util/walkerDelta";

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

/**
 * How fast the shells demo runs the clock.
 *
 * The story there is not one orbit but the *relative* motion between shells, and
 * that is slower: the 550 km shell laps a 1200 km one once every ~12.6 simulated
 * hours (the synodic period of their two orbital rates), and the two same-period
 * high shells drift apart in node by a couple of degrees of RAAN per simulated day
 * through J2. At 600× — a ladder rung — a full lap of the low shell past the high
 * ones takes about 76 s and the node drift of the high pair creeps along visibly,
 * where 60× would make both glacial. One orbit at 550 km is then 9.6 s, which is
 * fast but still countable.
 */
export const SHELLS_MULTIPLIER = 600;

/** The names `?demo=` understands. */
export const DEMO_NAMES = ["two-orbit", "sso", "migration", "walker25", "shells", "stable-shells", "real-fleet"] as const;
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
 * The two-orbit scene plus the live KV-cache migration overlay, over exactly the
 * satellites it hops between.
 */
export function applyMigrationScene(satStore: SatStore, cesiumStore: CesiumStore, clock: ClockControl): void {
  applyTwoOrbitScene(satStore, cesiumStore, clock);
  satStore.migration = true;
  satStore.links = true;
}

/**
 * The migration overlay over a larger fleet: 25 planes x 4 satellites, the
 * scenario the KV-cache line asks for. Same two-orbit look — illumination
 * colouring, labels, large points, inertial frame, 60x clock — but spread over
 * enough planes that an eclipse is always happening somewhere.
 */
export function applyWalker25Scene(satStore: SatStore, cesiumStore: CesiumStore, clock: ClockControl): void {
  const params: WalkerDeltaParams = { total: 100, planes: 25, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
  satStore.walker = [encodeWalker(params)];
  satStore.pointColorMode = "illumination";
  satStore.pointSize = "large";
  withIlluminationComponents(satStore);
  showOnly(satStore, [walkerTagFor(params)]);
  cesiumStore.cameraMode = "Inertial";
  satStore.migration = true;
  satStore.links = true;
  clock.setMultiplier(DEMO_MULTIPLIER);
  clock.play();
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

/**
 * Three Walker shells stacked in one scene — the scene for "what do different
 * constellation regimes do to each other", which no single pattern can show.
 *
 * The shells are chosen so every pair demonstrates a different kind of relative
 * motion:
 *
 * - **53° / 550 km vs the two high shells** — an altitude difference, so different
 *   periods, so the low shell continuously laps the high ones in the inertial frame.
 *   This is the fast, unmistakable motion: a full relative revolution every ~12.6
 *   simulated hours.
 * - **70° / 1200 km vs 97.6° / 1200 km** — the same period (same altitude), so they
 *   hold their along-track lock forever, but their inclinations differ, so J2
 *   precesses their nodes at different rates: retrograde for the 70° shell, slightly
 *   progressive for the 97.6° one. Their crossing seam migrates a couple of degrees
 *   of RAAN per simulated day — the slow motion a multi-inclination fleet really
 *   spends station-keeping on, since nothing here holds that seam for free.
 *
 * Within each shell the Walker pattern is as rigid as ever: equal periods keep the
 * plane rings and the phasing exact. What moves is shell against shell, which is
 * the point — a constellation is stable *inside* a shell by construction, and
 * stable *between* shells only where the design says so.
 */
export function applyShellsScene(satStore: SatStore, cesiumStore: CesiumStore, clock: ClockControl): void {
  // The low shell flies 10 per plane, not 6: a ring link's chord clears the
  // Earth only when a·cos(π/S) > R, which at 550 km asks for S ≥ 8 — the
  // derivation script's study 1 shows a 550 km S = 6 ring occluded 100% of the
  // time. The high shells keep S = 6, which clears at 1200 km with room to
  // spare.
  const shells: WalkerDeltaParams[] = [
    { total: 40, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    { total: 24, planes: 4, phasing: 1, inclinationDeg: 70, altitudeKm: 1200, raanSpanDeg: 360 },
    { total: 24, planes: 4, phasing: 1, inclinationDeg: 97.6, altitudeKm: 1200, raanSpanDeg: 360 },
  ];
  satStore.walker = shells.map(encodeWalker);
  satStore.pointColorMode = "illumination";
  satStore.pointSize = "large";
  withIlluminationComponents(satStore);
  showOnly(satStore, shells.map(walkerTagFor));
  // The topology overlay is half of what this scene argues: the rings hold
  // their length while the inter-plane links breathe, and both move with the
  // shells against each other.
  satStore.links = true;
  // The other half is a marked cluster - one same-slot satellite per shell,
  // bonded pairwise in amber. The bonds span shells, which the auto-topology
  // never draws, so the cluster makes the cross-shell shear directly
  // watchable: two of its members share a period and hold together, the third
  // laps them, and the amber triangle slowly shears open.
  satStore.marks = shells.map((shell) => `1-1@${encodeWalker(shell)}`);
  cesiumStore.cameraMode = "Inertial";
  clock.setMultiplier(SHELLS_MULTIPLIER);
  clock.play();
}

/**
 * The reference shell every stable-layout scene is built around, and the
 * companion the layout search picks for it.
 *
 * 53° / 550 km because it is the shell the rest of the app already opens with,
 * and 8:7 because it is the resonance whose companion lands nearest the 1200 km
 * altitude the stacked-shells demo already uses — the two scenes are then the
 * same picture with one number changed, which is what makes the comparison
 * legible. `searchStableShellLayouts` will offer shorter cycles (6:5 at 1456 km,
 * 7:6 at 1308 km); this one is the familiar altitude.
 */
export const STABLE_REFERENCE: WalkerDeltaParams = { total: 40, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };

/** The reference, its designed companion, and a shell picked the way the stacked-shells demo picks one. */
export function stableShellPatterns(): WalkerDeltaParams[] | undefined {
  const layout = resonantCompanion(STABLE_REFERENCE, 8, 7);
  const companion = layout && walkerPatternAt(STABLE_REFERENCE, layout, layout.minPerPlane);
  // The control: same altitude band, inclination chosen for coverage rather than
  // for the node rate. Everything the designed companion holds, this one loses.
  const control = walkerPatternAt(STABLE_REFERENCE, { altitudeKm: 1200, inclinationDeg: 97.6 }, 6);
  return companion && control ? [STABLE_REFERENCE, companion, control] : undefined;
}

/**
 * The stable-layout scene: one shell, the companion designed to hold against it,
 * and a companion that was not.
 *
 * The stacked-shells demo shows what two shells picked for their own sakes do to
 * each other — they shear, and the marked triangle opens without bound. This one
 * shows the alternative, which is a design rather than an accident: the middle
 * shell's inclination is solved so its node precesses at exactly the reference's
 * rate, and its altitude is solved so it turns 7 times for the reference's 8. The
 * planes then hold their arrangement and the phases come back every 12.7
 * simulated hours — the derivation measures 99.7% of satellites finding the same
 * cross-shell partner a cycle later, against 79% for the shell that was not
 * designed (`scripts/derive-isl-topology.ts`, studies 7-10).
 *
 * The marked cluster is where the difference is visible without reading a number:
 * one satellite from each shell, bonded pairwise. The bond to the designed
 * companion is drawn solid — its geometry returns — and the bond to the control
 * is dashed, and wanders. At {@link SHELLS_MULTIPLIER} the repeat cycle takes
 * about 76 s, so the solid bond visibly comes back to the same shape while the
 * dashed one never does.
 */
export function applyStableShellsScene(satStore: SatStore, cesiumStore: CesiumStore, clock: ClockControl): void {
  const shells = stableShellPatterns();
  if (!shells) {
    return;
  }
  satStore.walker = shells.map(encodeWalker);
  satStore.pointColorMode = "illumination";
  satStore.pointSize = "large";
  withIlluminationComponents(satStore);
  showOnly(satStore, shells.map(walkerTagFor));
  satStore.links = true;
  satStore.marks = shells.map((shell) => `1-1@${encodeWalker(shell)}`);
  cesiumStore.cameraMode = "Inertial";
  clock.setMultiplier(SHELLS_MULTIPLIER);
  clock.play();
}

/**
 * The migration overlay mapped onto a *real* catalogued constellation.
 *
 * Iridium NEXT is the fleet the demo maps onto because it is the one large
 * constellation that actually flies the thing being modelled — 80 satellites in
 * six near-polar planes, launched specifically to carry cross-linked traffic —
 * and because its group is small enough that the route search's per-decision
 * O(n²) sweep is cheap while still being a real OMM catalog, not a generated
 * pattern. The pipeline's stages are placed one per satellite across the real
 * fleet, the ledger measures sunlit serving time exactly as it does over the
 * Walker scenes, and the orbit lab's continuity report brackets what migration
 * can buy on it.
 *
 * Real records carry no plane-and-slot identity, so the topology overlay has
 * nothing to wire — the ISLs here are the routes the migration layer itself
 * plans, drawn leg by leg as they fly.
 */
export function applyRealFleetScene(satStore: SatStore, cesiumStore: CesiumStore, clock: ClockControl): void {
  satStore.pointColorMode = "illumination";
  satStore.pointSize = "large";
  withIlluminationComponents(satStore);
  // The tag the catalog registers for the iridium-NEXT group (see
  // src/config/presets.ts — bare group name matching worker/src/config/satvis.core.yaml).
  showOnly(satStore, ["IridiumNEXT"]);
  cesiumStore.cameraMode = "Inertial";
  satStore.migration = true;
  clock.setMultiplier(DEMO_MULTIPLIER);
  clock.play();
}

/** Whether a string is a demo `?demo=` understands. */
export function isDemoName(value: string | null | undefined): value is DemoName {
  return value != null && (DEMO_NAMES as readonly string[]).includes(value);
}

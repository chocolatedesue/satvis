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
import { nextTick, watch } from "vue";

import { currentPosition } from "../composables/useGeolocation";
import { BUILTIN_STAR_MAP, starMapRecovery } from "../config/starMaps";
import { SKY_MODE } from "../config/viewModes";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import { activeTargetEntries } from "./satelliteActivation";
import type { CatalogEntry } from "./SatelliteCatalog";
import type { DesiredScene } from "./SatelliteManager";
import type { Observer } from "./SkyView";
import { toMinuteIso } from "./util/urlCodec";

// Enough to keep a fast clock multiplier from hammering the history api.
const MIN_CLOCK_WRITE_MS = 1000;

// Above this many active satellites the name labels are switched off for the
// user (see the watcher that applies it). Roughly where they stop resolving
// into readable text on a 1080p globe.
const MAX_LABELLED_SATELLITES = 200;

/**
 * Everything this file touches on the globe, and nothing else.
 *
 * Declared structurally rather than as `CesiumController`, which is a 43-member
 * class that cannot be constructed without a WebGL context. What crosses this
 * seam is eighteen members, and writing them down is what says which parts of the
 * controller are load-bearing here — and what a test would have to stand in for.
 */
export interface SceneTarget {
  imageryLayers: string[];
  terrainProvider: string;
  cameraMode: string;
  pixelRatio: string;
  msaa: string;
  showFps: boolean;
  requestRenderMode: boolean;
  background: boolean;
  readonly skyView: {
    readonly active: boolean;
    enter(observer: Observer): Promise<void>;
    exit(): Promise<void>;
  };
  readonly skyInteraction: {
    start(): void;
    stop(): void;
  };
  readonly sats: {
    reconcile(desired: DesiredScene): void;
    onTrackedChange(callback: (name: string) => void): void;
    onCatalogChange(callback: () => void): void;
    // Read to size an activation before it is reconciled — how many satellites
    // a set of tags implies is a question about the catalog, not about what is
    // currently on the globe.
    readonly catalog: { readonly entries: readonly CatalogEntry[] };
  };
  readonly viewer: {
    readonly clock: {
      readonly currentTime: JulianDate;
      readonly onTick: { addEventListener(listener: () => void): () => void };
    };
    readonly timeline?: unknown;
  };
  applySurfaceModel(surfaceModel: string, viewMode: string): Promise<void>;
  applyStarMap(starMap: string): Promise<void>;
  suppressCameraMode(): void;
  releaseCameraMode(): void;
  morphTo(mode: string): void;
  setTime(time: string): void;
}

export function startSceneSync(cc: SceneTarget): void {
  const cesiumStore = useCesiumStore();
  const satStore = useSatStore();

  // --- globe settings -------------------------------------------------------

  // Immediate, because the store is the only owner of the layer stack: the viewer
  // is constructed with no base layer at all and the first stack arrives here.
  //
  // No availability correction any more. The base map's shallow levels are committed,
  // so there is no missing-imagery case to detect, and how deep it goes is settled
  // inside the provider's own construction rather than by rewriting the store. That
  // retires the one race this watcher used to have: being immediate, it first ran on
  // the store's default, and a probe answering after the route's preset had hydrated
  // wrote a swap of the *old* stack over the preset's chosen basemap.
  watch(
    () => cesiumStore.layers,
    (layers) => {
      cc.imageryLayers = [...layers];
    },
    { deep: true, immediate: true },
  );
  watch(
    () => cesiumStore.terrainProvider,
    (name) => {
      cc.terrainProvider = name;
    },
  );
  // Not immediate, unlike the render settings: the viewer is constructed with
  // exactly the built-in sky box, so there is nothing to bring into line until
  // the value moves, and a link that names it fetches nothing.
  //
  // Unlike the base map, this one still needs a fallback. The base map's shallow
  // levels are committed, so its only question is how deep to go and the provider
  // answers it for itself. A sky box has no such floor: the faces are either built
  // or absent, so the failure arrives here as a rejection and something has to put
  // the built-in back.
  watch(
    () => cesiumStore.starMap,
    (name) => {
      void applyStarMap(name);
    },
  );

  async function applyStarMap(name: string): Promise<void> {
    try {
      await cc.applyStarMap(name);
    } catch (error) {
      // The recovery hint travels with the path in starMaps.ts rather than being
      // written here, because it differs per map and this warning is the only
      // thing the reader gets.
      const recovery = starMapRecovery(name);
      console.warn(`Star map ${name} could not be loaded, falling back to ${BUILTIN_STAR_MAP}.${recovery ? ` Run \`${recovery}\` to build it.` : ""}`, error);
      // Read back rather than assuming: a second switch while the faces were in
      // flight has already asked for something else, and the one that failed is
      // no longer what anybody wants. Writing the built-in re-enters this
      // watcher, which is what puts it on the globe — and writing it over itself
      // is not a change, so a built-in that somehow fails cannot loop here.
      if (cesiumStore.starMap === name) {
        cesiumStore.starMap = BUILTIN_STAR_MAP;
      }
    }
  }
  // Both arguments, one watcher: what a surface model does depends on the view
  // mode as much as on the selection, and there is nothing to gain from
  // discovering which of the two moved. Immediate, because `?surface=` arrives
  // before anything else would trigger it.
  watch(
    () => [cesiumStore.surfaceModel, cesiumStore.sceneMode] as const,
    ([surfaceModel, viewMode]) => {
      void cc.applySurfaceModel(surfaceModel, viewMode);
    },
    { immediate: true },
  );
  // The view mode is the one setting that cannot be a plain assignment. Three
  // of the four are a Cesium projection, but "Sky" needs an observer, which may
  // still be arriving from the url or may have to be asked for — so entering is
  // an action with a result, and a refusal has to put the mode back.
  let viewModeGeneration = 0;

  async function resolveObserver(): Promise<Observer | undefined> {
    // The cesium and sat stores hydrate from the url independently, so a ground
    // station in `?gs=` can land a tick after the view mode in `?scene=` does.
    // Waiting is the difference between using the observer the link supplied and
    // prompting for a location on top of it.
    await nextTick();
    const existing = satStore.groundStations[0];
    if (existing) {
      return { lat: existing.lat, lon: existing.lon };
    }

    const fix = await currentPosition();
    if (!fix) {
      return undefined;
    }
    // The device's location becomes a ground station rather than a private
    // second notion of "here": the sky view's next-pass figures are then the
    // passes the app was already computing. Read it back rather than reusing
    // `fix`, so the observer is the rounded value the store and url agree on.
    satStore.setGroundStations([...satStore.groundStations, { ...fix, name: "Geolocation" }]);
    const created = satStore.groundStations[0];
    return created ? { lat: created.lat, lon: created.lon } : undefined;
  }

  async function applyViewMode(mode: string, previous: string): Promise<void> {
    const generation = ++viewModeGeneration;

    if (mode !== SKY_MODE) {
      cc.skyInteraction.stop();
      // The flight back up to the globe is the descent reversed, and until it
      // lands the camera is still the sky view's. Morphing the projection or
      // handing the camera back to the camera mode mid-flight would take it away
      // underneath, so both wait — and a switch straight back into the sky turns
      // the flight around, which makes this answer one about a view that never
      // left.
      await cc.skyView.exit();
      if (generation !== viewModeGeneration) {
        return;
      }
      cc.releaseCameraMode();
      cc.morphTo(mode);
      return;
    }

    const observer = await resolveObserver();
    // Leaving again while the browser was asking for a location, or a second
    // switch overtaking this one, makes this answer stale.
    if (generation !== viewModeGeneration) {
      return;
    }
    if (!observer) {
      console.warn("Sky view needs an observer: no ground station, and no location from the device");
      cesiumStore.sceneMode = previous === SKY_MODE ? "3D" : previous;
      return;
    }

    // Both of these fight the sky view for the camera, and they are handled
    // differently on purpose — see docs/adr/0003-sky-view.md. Inertial is
    // suppressed, so `?camera=Inertial` survives the round trip. Tracking is
    // cleared, because a camera cannot both follow a satellite and be a pair of
    // eyes on the ground, so there is nothing to come back to.
    cc.suppressCameraMode();
    satStore.trackedSatellite = "";
    // Looking around waits for the descent to land. Both the drag and the device
    // sensor write the aim, and the aim is the flight's destination — a gesture
    // during the descent would steer it rather than move a view that has
    // arrived, and there is nothing recognisable on screen to aim with yet.
    await cc.skyView.enter(observer);
    if (generation !== viewModeGeneration) {
      return;
    }
    cc.skyInteraction.start();
  }

  watch(
    () => cesiumStore.sceneMode,
    (mode, previous) => {
      void applyViewMode(mode, previous);
    },
  );

  // Nothing is tracked while the sky view is up, held as a standing invariant
  // rather than a one-off clear on entry. A track can arrive later than the
  // view mode does: `pendingTrackedSatellite` resolves whenever its group
  // finishes loading, which can be long after. Writing the store rather than
  // `viewer.trackedEntity` matters — tracking is the one value the globe
  // reports back, so poking Cesium would reach the store from behind and race
  // the forward path.
  watch(
    () => satStore.trackedSatellite,
    (tracked) => {
      if (tracked !== "" && cc.skyView.active) {
        satStore.trackedSatellite = "";
      }
    },
  );

  // Moving the first ground station moves the observer under a live sky view.
  // Removing every station does not close it: the view stays where it was
  // rather than collapsing out from under someone editing their stations.
  watch(
    () => satStore.groundStations[0],
    (station) => {
      if (station && cc.skyView.active) {
        // A move, which `enter` does without flying — the promise is only about
        // a flight, and there is none to wait for here.
        void cc.skyView.enter({ lat: station.lat, lon: station.lon });
      }
    },
    { deep: true },
  );
  watch(
    () => cesiumStore.cameraMode,
    (mode) => {
      cc.cameraMode = mode;
    },
  );
  watch(
    () => cesiumStore.pixelRatio,
    (ratio) => {
      cc.pixelRatio = ratio;
    },
    { immediate: true },
  );
  // Immediate, for the same reason as render-on-demand below: a url that asks
  // for `msaa=off` should be in force from the first frame rather than after
  // the first time the control is touched.
  watch(
    () => cesiumStore.msaa,
    (rate) => {
      cc.msaa = rate;
    },
    { immediate: true },
  );
  watch(
    () => cesiumStore.showFps,
    (show) => {
      cc.showFps = show;
    },
  );
  // Immediate, so the store's value is the one in force from the first frame
  // rather than whatever the viewer was constructed with.
  watch(
    () => cesiumStore.requestRenderMode,
    (on) => {
      cc.requestRenderMode = on;
    },
    { immediate: true },
  );
  watch(
    () => cesiumStore.background,
    (on) => {
      cc.background = on;
    },
  );

  // --- the scene ------------------------------------------------------------

  // How many satellites the current activation implies, asked of the catalog
  // rather than of the globe so the answer is available before anything is
  // built. Touches catalogRevision so a lazily-loaded group re-runs it as its
  // entries land — enabling a tag counts 0 until then.
  const activeSatelliteCount = (): number => {
    void satStore.catalogRevision;
    return activeTargetEntries({
      entries: cc.sats.catalog.entries,
      enabledTags: satStore.enabledTags,
      enabledSatellites: satStore.enabledSatellites,
      disabledSatellites: satStore.disabledSatellites,
      trackedName: satStore.trackedSatellite || undefined,
    }).size;
  };

  // Labels stop being readable long before they stop being drawn: past a couple
  // of hundred they overlap into a mass that hides the globe and says nothing.
  // Switch them off as the count crosses the threshold.
  //
  // A real store write, not a suppression — the checkbox unticks, the url
  // follows, and turning labels back on at 5,000 satellites is the user's call
  // to make and it sticks. Edge-triggered for exactly that reason: it fires on
  // the crossing, so re-enabling survives every later change that leaves the
  // count above the threshold, and only a drop back under and a fresh crossing
  // switches them off again.
  let overLabelBudget = false;
  watch(
    activeSatelliteCount,
    (count) => {
      const over = count > MAX_LABELLED_SATELLITES;
      if (over && !overLabelBudget) {
        satStore.enabledComponents = satStore.enabledComponents.filter((component) => component !== "Label");
      }
      overLabelBudget = over;
    },
    { immediate: true },
  );

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

// useSelectedEntity — bridges the Cesium selection to Vue reactivity for the
// entity info panel. `viewer.selectedEntity` stays the single source of truth:
// this composable only observes it (via selectedEntityChanged) and resolves it
// to the owning SatelliteComponentCollection or GroundStationEntity; it never
// changes the selection itself except in `deselect()`, which mirrors the native
// InfoBox close button (`viewer.selectedEntity = undefined`).
//
// State lives at module scope as a lazy singleton wired up on first use.
// While something is selected, a 1 s periodic clock callback refreshes the
// time-dependent data (position, pass countdowns) and re-resolves the selection
// so a satellite disposed mid-selection (e.g. its tag toggled off) hides the
// panel within a second. The callback is gated on *simulation* time, so the
// countdown freezes while the clock is paused — the same behavior the old
// InfoBox had with its 1 s-cached description CallbackProperty.
//
// Cesium objects are held via shallowRef/markRaw only: a deep reactive proxy
// would break the `viewer.selectedEntity === entity` identity checks inside
// `isSelected`.

import { JulianDate } from "@cesium/engine";
import { storeToRefs } from "pinia";
import { markRaw, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";

import type { GroundStationEntity } from "../modules/GroundStationEntity";
import { filterPasses, toPassRows, type PassRow } from "../modules/PassPredictor";
import type { SatelliteComponentCollection } from "../modules/SatelliteComponentCollection";
import { CesiumCallbackHelper } from "../modules/util/CesiumCallbackHelper";
import { getElementsInfo, type ElementsInfo } from "../modules/util/entityInfo";
import { useSatStore } from "../stores/sat";

export type Selection = { kind: "satellite"; sat: SatelliteComponentCollection } | { kind: "groundstation"; gs: GroundStationEntity };

export interface PositionRow {
  label: string;
  value: string;
}

// --- Module-scoped state (lazy singleton) ---
const selection: ShallowRef<Selection | null> = shallowRef(null);
const isTracked = ref(false);
const name = ref("");
const position: Ref<PositionRow[]> = ref([]);
const passRows: Ref<PassRow[]> = ref([]);
// Whether the entity has any computed passes at all (before dropping past
// ones); distinguishes the empty-state texts from an empty passes table.
const hasAnyPasses = ref(false);
// Include already-finished passes in the table. Off by default so the list
// starts at the ongoing/next pass.
const showPastPasses = ref(false);
const groundStationAvailable = ref(false);
const elements: ShallowRef<ElementsInfo | null> = shallowRef(null);

let initialized = false;
let removeTickCallback: (() => void) | undefined;

function selectionTarget(sel: Selection | null): SatelliteComponentCollection | GroundStationEntity | null {
  if (!sel) {
    return null;
  }
  return sel.kind === "satellite" ? sel.sat : sel.gs;
}

function resolveSelection(): Selection | null {
  const { viewer, sats } = globalThis.cc;
  if (!viewer.selectedEntity) {
    return null;
  }
  const sat = sats.activeSatellites.find((s) => s.isSelected);
  if (sat) {
    return { kind: "satellite", sat: markRaw(sat) };
  }
  const gs = sats.groundStations.find((g) => g.isSelected);
  if (gs) {
    return { kind: "groundstation", gs: markRaw(gs) };
  }
  return null;
}

function syncTracked(): void {
  isTracked.value = selectionTarget(selection.value)?.isTracked ?? false;
}

function refreshData(sel: Selection, time: JulianDate): void {
  const { sats } = globalThis.cc;
  const mode = sats.overpassMode;
  groundStationAvailable.value = sats.groundStationAvailable;

  if (sel.kind === "satellite") {
    const { props } = sel.sat;
    name.value = props.name;
    // Window-guarded: recomputes only when outside the current pass window,
    // which keeps the list valid after large time jumps.
    const passes = props.passPredictor.passes(time);
    const cartographic = props.orbit.positionGeodetic(JulianDate.toDate(time), true);
    position.value = cartographic
      ? [
          { label: "Name", value: props.name },
          { label: "Latitude", value: `${cartographic.latitude.toFixed(2)}°` },
          { label: "Longitude", value: `${cartographic.longitude.toFixed(2)}°` },
          { label: "Altitude", value: `${(cartographic.height / 1000).toFixed(2)} km` },
          { label: "Velocity", value: `${(cartographic.velocity ?? 0).toFixed(2)} km/s` },
        ]
      : [];
    hasAnyPasses.value = passes.length > 0;
    passRows.value = toPassRows(filterPasses(passes, time, showPastPasses.value), time, "groundStationName", mode);
  } else {
    const { gs } = sel;
    name.value = gs.name;
    position.value = [
      { label: "Name", value: gs.name },
      { label: "Latitude", value: `${gs.position.latitude.toFixed(2)}°` },
      { label: "Longitude", value: `${gs.position.longitude.toFixed(2)}°` },
    ];
    const passes = gs.passes(time);
    hasAnyPasses.value = passes.length > 0;
    passRows.value = toPassRows(filterPasses(passes, time, showPastPasses.value), time, "name", mode);
  }
}

function update(time?: JulianDate): void {
  const { viewer } = globalThis.cc;
  const now = time ?? viewer.clock.currentTime;
  const next = resolveSelection();
  const previousTarget = selectionTarget(selection.value);

  if (selectionTarget(next) !== previousTarget) {
    selection.value = next;
    elements.value = next?.kind === "satellite" ? getElementsInfo(next.sat.props.orbit) : null;
    if (next && !removeTickCallback) {
      removeTickCallback = CesiumCallbackHelper.createPeriodicTimeCallback(viewer, 1, (tickTime) => update(tickTime));
    } else if (!next && removeTickCallback) {
      removeTickCallback();
      removeTickCallback = undefined;
    }
  }

  if (next) {
    refreshData(next, now);
  }
  syncTracked();
}

function init(): void {
  const { viewer } = globalThis.cc;
  viewer.selectedEntityChanged.addEventListener(() => update());
  viewer.trackedEntityChanged.addEventListener(() => syncTracked());
  // Flip the passes table columns immediately on mode change instead of
  // waiting for the next periodic refresh. The manager (cc.sats.overpassMode)
  // is updated by the Satvis.vue store watcher, which runs before this one
  // (registered earlier), so reading the manager value in refreshData is safe.
  const { overpassMode } = storeToRefs(useSatStore());
  watch(overpassMode, () => update());
  // Rebuild the table immediately when past passes are toggled instead of
  // waiting for the next periodic refresh.
  watch(showPastPasses, () => update());
  // Pick up a selection made before the first panel mount.
  update();
}

export function useSelectedEntity() {
  if (!initialized) {
    initialized = true;
    init();
  }

  function deselect(): void {
    globalThis.cc.viewer.selectedEntity = undefined;
  }

  function toggleTrack(): void {
    const target = selectionTarget(selection.value);
    if (!target) {
      return;
    }
    if (target.isTracked) {
      globalThis.cc.viewer.trackedEntity = undefined;
    } else {
      target.track();
    }
  }

  return {
    selection,
    isTracked,
    name,
    position,
    passRows,
    hasAnyPasses,
    showPastPasses,
    groundStationAvailable,
    elements,
    deselect,
    toggleTrack,
  };
}

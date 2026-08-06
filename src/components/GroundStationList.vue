<template>
  <div class="gsList">
    <div v-if="stations.length === 0" class="toolbarNote gsList__empty">None yet — pick one on the globe, or use your own position.</div>
    <div
      v-for="(station, index) in stations"
      :key="index"
      class="gsList__row"
      :class="{ 'gsList__row--first': index === 0, 'gsList__row--dragged': drag?.from === index, 'gsList__row--settling': settling }"
      :style="{ transform: `translateY(${offsetOf(index)}px)` }"
    >
      <span class="gsList__rank" :title="index === 0 ? 'The sky view stands here' : undefined">{{ index === 0 ? "◉" : index + 1 }}</span>
      <!-- Keyboard-operable as well as draggable: dragging is the only way to
           reorder now, and a list that can only be reordered with a pointer is
           one some people cannot reorder at all. -->
      <span
        class="gsList__grip"
        role="button"
        tabindex="0"
        title="Drag to reorder"
        @pointerdown="startDrag(index, $event)"
        @pointermove="moveDrag($event)"
        @pointerup="endDrag($event)"
        @pointercancel="endDrag($event)"
        @keydown.up.prevent="nudge(index, -1)"
        @keydown.down.prevent="nudge(index, 1)"
      >
        <UIcon name="lucide:grip-vertical" />
      </span>
      <input
        class="gsList__name"
        type="text"
        :value="station.name ?? ''"
        placeholder="unnamed"
        aria-label="Name"
        @change="commitName(index, $event)"
        @keydown.enter="commit"
        @keydown.esc="abandon($event, station.name ?? '')"
      />
      <input
        class="gsList__coord"
        type="text"
        inputmode="decimal"
        :value="station.lat"
        aria-label="Latitude"
        @change="commitCoordinate(index, 'lat', $event)"
        @keydown.enter="commit"
        @keydown.esc="abandon($event, String(station.lat))"
      />
      <input
        class="gsList__coord"
        type="text"
        inputmode="decimal"
        :value="station.lon"
        aria-label="Longitude"
        @change="commitCoordinate(index, 'lon', $event)"
        @keydown.enter="commit"
        @keydown.esc="abandon($event, String(station.lon))"
      />
      <button type="button" class="gsList__remove" title="Remove" @click="removeAt(index)">×</button>
    </div>

    <div class="gsList__actions">
      <button type="button" :class="{ 'gsList__action--on': pickMode }" @click="pickMode = !pickMode">Pick on globe</button>
      <button type="button" :disabled="locating" @click="void locate()">
        <span v-if="locating" class="toolbarSpinner gsList__spinner"></span>
        My location
      </button>
    </div>

    <!-- The rule the list is arranged around: the sky view stands at the first
         station, so the order is not presentation, it is the setting. And the way
         to change it, because a grip says a row can move without saying that
         moving it decides anything. Under the list and the buttons rather than
         over them — by the time it matters you have a list to read it against,
         and above the rows it was the first thing in a panel whose first thing
         should be the stations. -->
    <div class="toolbarNote">The sky view uses the first location, drag to reorder.</div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { nextTick, ref } from "vue";

import { useController } from "../composables/useController";
import { useGeolocation } from "../composables/useGeolocation";
import { dragShift, dropIndex, MAX_LATITUDE, MAX_LONGITUDE, moved, parseCoordinate, relocated, renamed, without } from "../modules/util/groundStationEdits";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";

const cc = useController();
const satStore = useSatStore();
const { groundStations: stations } = storeToRefs(satStore);
const { pickMode } = storeToRefs(useCesiumStore());
const { pending: locating, locate } = useGeolocation(cc);

/**
 * Put back whatever the store kept — the rounded value, or the old one where the
 * edit was refused — because the input holds what was typed and the store is
 * what is true. Vue will not do it: the bound value has not changed from its
 * point of view, so there is nothing for it to patch.
 */
function settle(input: HTMLInputElement, value: string): void {
  input.value = value;
}

/**
 * Enter finishes an edit, and Escape abandons it.
 *
 * Both go through blur, because `change` is what commits and blur is what raises
 * it: a text input outside a form does not raise `change` on Enter — measured, not
 * assumed — so without this a typed coordinate sits in the field looking committed
 * and is not. Escape puts the stored value back first, which also means the blur
 * that follows finds nothing changed.
 */
function commit(event: KeyboardEvent): void {
  (event.target as HTMLInputElement).blur();
}

function abandon(event: KeyboardEvent, stored: string): void {
  const input = event.target as HTMLInputElement;
  input.value = stored;
  input.blur();
}

/**
 * On `change` rather than on `input`, so a commit is one deliberate act: every
 * one of these is a store write, a url history entry, and a recomputation of
 * every active satellite's passes. Per keystroke that is six of each for
 * "Munich".
 */
function commitName(index: number, event: Event): void {
  const input = event.target as HTMLInputElement;
  satStore.setGroundStations(renamed(stations.value, index, input.value));
  settle(input, stations.value[index]?.name ?? "");
}

function commitCoordinate(index: number, field: "lat" | "lon", event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = parseCoordinate(input.value, field === "lat" ? MAX_LATITUDE : MAX_LONGITUDE);
  if (value !== undefined) {
    satStore.setGroundStations(relocated(stations.value, index, field, value));
  }
  settle(input, String(stations.value[index]?.[field] ?? ""));
}

function removeAt(index: number): void {
  satStore.setGroundStations(without(stations.value, index));
}

// --- reordering ------------------------------------------------------------
// Pointer events rather than HTML5 drag-and-drop, which does not exist on touch
// at all — and the sky view this order decides is the phone feature. The row
// height is measured at the start of each drag rather than pinned to a constant,
// so the arithmetic cannot drift from the stylesheet.
const drag = ref<{ from: number; to: number; offset: number; rowHeight: number } | undefined>();

/**
 * The one frame in which a drop lands, with transitions off.
 *
 * The rows are keyed by position, so committing a reorder swaps the *content* of
 * rows that are still holding the drag's transform. Content and transform have to
 * arrive in the same paint: left to the transition, the transform unwinds over
 * 120 ms while the new content is already in place, and the row is seen flying
 * back to where it was dragged from. Cleared a frame later, so the parting
 * animation is there for the next drag.
 */
const settling = ref(false);

function startDrag(index: number, event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement;
  const row = handle.parentElement?.getBoundingClientRect();
  handle.setPointerCapture(event.pointerId);
  drag.value = { from: index, to: index, offset: 0, rowHeight: row?.height ?? 0 };
}

function moveDrag(event: PointerEvent): void {
  const current = drag.value;
  if (!current) {
    return;
  }
  // Movement rather than a start position: the handle has the pointer captured,
  // so every move is reported here whatever it is over.
  const offset = current.offset + event.movementY;
  drag.value = { ...current, offset, to: dropIndex(current.from, offset, current.rowHeight, stations.value.length) };
}

function endDrag(event: PointerEvent): void {
  const current = drag.value;
  drag.value = undefined;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  // A tap on the handle ends where it started, and writing the store for that
  // would cost a url entry and every satellite's passes for nothing.
  if (current && current.to !== current.from) {
    settling.value = true;
    satStore.setGroundStations(moved(stations.value, current.from, current.to - current.from));
    void nextTick(() => requestAnimationFrame(() => (settling.value = false)));
  }
}

/** Arrow keys on the grip, for the reordering a pointer drag cannot do. */
function nudge(index: number, by: number): void {
  satStore.setGroundStations(moved(stations.value, index, by));
}

/** Where a row sits while a drag is in progress: the dragged one follows the
 *  pointer, the ones it has passed step aside by exactly one row. */
function offsetOf(index: number): number {
  const current = drag.value;
  if (!current) {
    return 0;
  }
  return index === current.from ? current.offset : dragShift(index, current.from, current.to, current.rowHeight);
}
</script>

<style scoped>
.gsList__empty {
  font-style: italic;
}

.gsList__row {
  align-items: center;
  background-color: #464b50;
  border-radius: 6px;
  display: flex;
  gap: 3px;
  height: 24px;
  margin: 1px 0;
  opacity: 0.85;
  padding: 0 3px;
  transition: transform 120ms ease-out;
}

/* The one the sky view stands at, marked on the row as well as in the note, so
   the answer survives once the note has scrolled out of mind. */
.gsList__row--first {
  background-color: #4a5b50;
  opacity: 1;
}

/* The frame a drop lands in. The transform goes back to zero in the same paint
   as the reordered content arrives, so there is nothing to see rather than a row
   sliding back to where it came from. */
.gsList__row--settling {
  transition: none;
}

/* Under the pointer: no transition, because it is following a finger rather than
   animating to a place, and above its neighbours as it crosses them. */
.gsList__row--dragged {
  box-shadow: 0 2px 8px #0006;
  position: relative;
  transition: none;
  z-index: 1;
}

.gsList__rank {
  color: #4ade80;
  flex: none;
  font-size: 11px;
  line-height: 24px;
  text-align: center;
  user-select: none;
  width: 12px;
}

.gsList__grip {
  align-items: center;
  cursor: grab;
  display: flex;
  flex: none;
  font-size: 12px;
  opacity: 0.45;
  /* So a touch drag moves the row instead of scrolling the panel. */
  touch-action: none;
  user-select: none;
}

.gsList__grip:hover {
  opacity: 0.9;
}

.gsList__grip:active {
  cursor: grabbing;
  opacity: 1;
}

.gsList__grip:focus-visible {
  border-radius: 3px;
  outline: 1px solid #4ade80;
}

.gsList__name,
.gsList__coord {
  background: none;
  border: none;
  border-bottom: 1px solid #edffff26;
  color: #edffff;
  min-width: 0;
  padding: 0 1px;
}

.gsList__name:focus,
.gsList__coord:focus {
  border-bottom-color: #4ade80;
  outline: none;
}

/* An explicit width, not only a flex basis: an input's intrinsic width is its
   `size` attribute — about 20 characters — and the panel is shrink-to-fit, so
   three of them per row asked for a panel twice the width of every other one. */
.gsList__name {
  flex: 1 1 auto;
  font-size: 12px;
  width: 74px;
}

.gsList__name::placeholder {
  color: #edffff;
  font-style: italic;
  opacity: 0.35;
}

.gsList__coord {
  flex: 0 0 auto;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  width: 52px;
}

.gsList__remove {
  background: none;
  border: none;
  color: #edffff;
  cursor: pointer;
  flex: none;
  font-size: 15px;
  line-height: 1;
  opacity: 0.6;
  padding: 0 1px;
}

.gsList__remove:hover {
  color: #fca5a5;
  opacity: 1;
}

.gsList__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0 2px;
}

.gsList__actions button {
  align-items: center;
  background-color: #464b50;
  border: 1px solid transparent;
  border-radius: 6px;
  color: #edffff;
  cursor: pointer;
  display: flex;
  flex: 1 1 auto;
  font-size: 11px;
  gap: 4px;
  justify-content: center;
  padding: 4px 6px;
  white-space: nowrap;
}

.gsList__actions button:hover:not(:disabled) {
  background-color: #5a6167;
}

.gsList__actions button:disabled {
  cursor: default;
  opacity: 0.6;
}

/* Picking is a mode, not an act: it stays on until a click on the globe answers
   it, so the control has to look switched on for as long as that lasts. */
.gsList__action--on {
  border-color: #4ade80;
  color: #4ade80;
}

.gsList__spinner {
  height: 10px;
  width: 10px;
}
</style>

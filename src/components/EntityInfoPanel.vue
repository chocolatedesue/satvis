<!-- What is selected, in four species of data: identity, live position, the pass
     list, and the reference material.
     Only two of those are permanent. The header says what this is, and the strip
     under it says where it is — the two facts worth having on screen whatever else
     you are reading. The rest is two tabs, because stacking all four produced a
     1384 px scroll inside a 500 px window, two thirds of it below the fold, with
     the element table under thirty rows of the same station name.

     `Passes` is the default tab and leads with the countdown, which is the reason
     the panel is usually open at all — then the timeline, which says which of the
     next several are worth going outside for, then the list. `Details` is what you
     go looking for rather than glance at. -->
<template>
  <div v-if="selection" class="entity-info-panel">
    <UCard :ui="{ root: 'bg-[#303336]/95 text-[#edffff] divide-neutral-600', header: 'p-2 sm:px-3', body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="head">
          <div class="head__title">
            <span v-if="orbitClass" class="dot" :style="{ background: orbitColor }" :title="orbitClass" />
            <input
              v-if="renaming"
              ref="renameEl"
              v-model="draftName"
              class="head__rename"
              type="text"
              placeholder="unnamed"
              aria-label="Station name"
              @keydown.enter="commitRename"
              @keydown.esc="cancelRename"
              @blur="commitRename"
            />
            <span v-else class="head__name">{{ name }}</span>
            <UTooltip v-if="canRename" :text="renaming ? 'Done' : 'Rename'">
              <!-- Keeps focus in the input, so pressing it commits once through
                   the click rather than once through the blur and then reopening. -->
              <UButton
                :icon="renaming ? 'i-lucide-check' : 'i-lucide-pencil'"
                variant="ghost"
                color="neutral"
                size="xs"
                :aria-label="renaming ? 'Finish renaming' : 'Rename station'"
                @mousedown.prevent
                @click="toggleRename"
              />
            </UTooltip>
            <span class="head__id">{{ satnum ? `#${satnum}` : "" }}</span>
            <UTooltip text="Notify for upcoming passes">
              <UButton icon="i-lucide-bell" variant="ghost" color="neutral" size="xs" aria-label="Notify for upcoming passes" @click="notifyPasses" />
            </UTooltip>
            <UTooltip v-if="canEnterSkyView" text="View the sky from here">
              <UButton icon="i-lucide-telescope" variant="ghost" color="neutral" size="xs" aria-label="View the sky from this ground station" @click="enterSkyView" />
            </UTooltip>
            <!-- Hidden rather than disabled in the sky view, which owns the camera:
                 tracking there has no meaning to convey, and a button that silently
                 did nothing would read as broken. -->
            <UTooltip v-if="!inSkyView" :text="isTracked ? 'Stop tracking' : 'Track entity'">
              <UButton icon="i-lucide-video" variant="ghost" :color="isTracked ? 'primary' : 'neutral'" size="xs" aria-label="Track entity" @click="toggleTrack" />
            </UTooltip>
            <UButton icon="i-lucide-x" variant="ghost" color="neutral" size="xs" aria-label="Close" @click="deselect" />
          </div>
          <div v-if="chips.length > 0" class="head__chips">
            <span v-for="chip in chips" :key="chip">{{ chip }}</span>
          </div>
        </div>
      </template>

      <!-- Where it is. Four cells and three-letter labels, because nobody reads a
           longitude to two decimals — they check it has not gone somewhere absurd. -->
      <div v-if="liveRows.length > 0" class="strip">
        <span v-for="row in liveRows" :key="row.label" class="strip__cell">
          <span class="strip__label">{{ row.label.slice(0, 3) }}</span>
          <span class="strip__value">{{ row.value }}</span>
        </span>
      </div>

      <!-- A lone tab is a control that switches to nothing, which a ground station
           hits: no satellite facts and no elements means no `Details`.

           `min-h-8` is the height a trigger takes once it carries a badge. Reserved
           always, because the badge appears only once the pass count is known: the
           row grew by 4 px the moment prediction landed, and everything under it
           dropped with it. -->
      <UTabs
        v-model="activeTab"
        :items="tabs"
        variant="link"
        size="sm"
        :ui="{
          root: 'gap-0',
          list: tabs.length > 1 ? 'px-2 border-y border-neutral-600' : 'hidden',
          trigger: 'min-h-8',
          content: 'px-3 pb-3 info-body',
        }"
      >
        <template #passes>
          <!-- Restores the top padding the scroll container gave up so that the
               table header below can pin flush with its top edge. With the padding
               on the container, rows scrolled through the gap above the pinned
               header and stayed visible there. -->
          <div class="tab-body__pad">
            <!-- No empty state for the hero: when there is no upcoming pass the
                 message below says so once. -->
            <template v-if="!passesPending && hasAnyPasses">
              <div v-if="nextPass" class="hero" :class="{ 'hero--live': isOngoing }">
                <div class="hero__label">
                  {{ isOngoing ? "Overhead now" : "Next pass" }}
                  <span v-if="nextPassSubject">· {{ nextPassSubject }}</span>
                </div>
                <div class="hero__value">{{ formatCountdown(nowMs, nextPass) }}</div>
                <div class="hero__meta">{{ passSummary(nextPass) }}</div>
                <div v-if="isOngoing" class="hero__progress"><span :style="{ width: `${ongoingFraction * 100}%` }" /></div>
              </div>

              <pass-timeline v-if="showTimeline" :passes="passes" :now-ms="nowMs" :mode="overpassMode" :picked="pickedPassMs" @pick="pickPass" />
            </template>

            <!-- Outside every empty branch on purpose. The mode decides what the two
                 right-hand columns and the strip mean, and it can produce a list
                 with nothing in it — swath mode over a station the ground track
                 misses — so a control that appears only when there are passes is one
                 you cannot use to undo the switch that emptied the tab. -->
            <div class="passes__bar">
              <div class="modes" role="group" aria-label="Overpass calculation">
                <button
                  v-for="option in OVERPASS_MODES"
                  :key="option.value"
                  type="button"
                  class="modes__option"
                  :class="{ 'modes__option--on': overpassMode === option.value }"
                  :aria-pressed="overpassMode === option.value"
                  @click="overpassMode = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
              <USwitch v-model="showPastPasses" label="Past" size="xs" />
            </div>

            <div v-if="passesPending" class="empty">Computing passes…</div>
            <div v-else-if="!hasAnyPasses" class="empty">{{ emptyPassText }}</div>
            <div v-else-if="passRows.length === 0" class="empty">No upcoming passes</div>
            <table v-else ref="tableEl" class="info-table">
              <thead>
                <tr>
                  <th v-if="subjectCount > 1">{{ selection.kind === "groundstation" ? "Satellite" : "Station" }}</th>
                  <th>In</th>
                  <th>Start</th>
                  <th>End</th>
                  <th class="num">{{ overpassMode === "swath" ? "Dist" : "El" }}</th>
                  <th class="num">{{ overpassMode === "swath" ? "Swath" : "Az" }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in passRows"
                  :key="row.key"
                  :data-start-ms="row.startMs"
                  :class="{ 'is-next': row.startMs === nextPass?.start, 'is-picked': row.startMs === pickedPassMs }"
                >
                  <td v-if="subjectCount > 1">{{ row.name }}</td>
                  <td class="mono">{{ row.countdown }}</td>
                  <td>
                    <a class="link" @click="cc.setTime(row.startMs)">{{ row.startLabel }}</a>
                  </td>
                  <td>{{ row.endLabel }}</td>
                  <td class="num">{{ row.primary }}</td>
                  <td class="num">{{ row.secondary }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template #details>
          <div class="tab-body__pad">
            <table v-if="satelliteInfo.length > 0" class="info-table info-table--facts">
              <tbody>
                <tr v-for="[label, value] in satelliteInfo" :key="label">
                  <th>{{ label }}</th>
                  <td class="right">{{ value }}</td>
                </tr>
              </tbody>
            </table>

            <template v-if="links.length > 0">
              <div class="section">Links</div>
              <div class="links">
                <a v-for="link in links" :key="link.label" class="links__item" :href="link.href" :title="link.title" target="_blank" rel="noopener">{{ link.label }}</a>
              </div>
            </template>

            <template v-if="elements">
              <div class="section">{{ elements.kind === "tle" ? "TLE" : "Elements" }} · epoch {{ elements.epoch }}</div>
              <pre v-if="elements.kind === 'tle'" class="info-code"><code>{{ elements.lines }}</code></pre>
              <table v-else class="info-table info-table--facts">
                <tbody>
                  <tr v-for="[label, value] in elements.rows" :key="label">
                    <th>{{ label }}</th>
                    <td class="right mono">{{ value }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
          </div>
        </template>
      </UTabs>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "@nuxt/ui/composables/useToast";
import dayjs from "dayjs";
import { storeToRefs } from "pinia";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";

import { useController } from "../composables/useController";
import { useSelectedEntity } from "../composables/useSelectedEntity";
import { externalLinks } from "../config/externalLinks";
import { ORBIT_CLASS_COLOR, type OrbitClass } from "../config/orbitClass";
import { SKY_MODE } from "../config/viewModes";
import { formatCountdown, passSummary, type Pass } from "../modules/PassPredictor";
import { renamed } from "../modules/util/groundStationEdits";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import PassTimeline from "./PassTimeline.vue";

const cc = useController();
const toast = useToast();

const {
  selection,
  isTracked,
  name,
  position,
  passRows,
  passes,
  nextPass,
  subjectCount,
  nowMs,
  hasAnyPasses,
  passesPending,
  showPastPasses,
  pickedPassMs,
  pickPass,
  preferredTab,
  groundStationAvailable,
  elements,
  satelliteInfo,
  canEnterSkyView,
  enterSkyView,
  deselect,
  toggleTrack,
} = useSelectedEntity(cc);

const satStore = useSatStore();
const { overpassMode } = storeToRefs(satStore);
const { sceneMode } = storeToRefs(useCesiumStore());
const inSkyView = computed(() => sceneMode.value === SKY_MODE);
const OVERPASS_MODES = [
  { value: "elevation", label: "Elevation" },
  { value: "swath", label: "Swath" },
] as const;

/** Asks whether a station exists, not what kind of thing is selected: a satellite
 *  with a station set and an empty window has a different problem. */
const emptyPassText = computed(() => (groundStationAvailable.value ? "No passes in the prediction window" : "No ground station set"));

const satnum = computed(() => (selection.value?.kind === "satellite" ? selection.value.sat.props.satnum : undefined));
const links = computed(() => (satnum.value ? externalLinks(satnum.value) : []));

// The derived facts lead `satelliteInfo`, so the orbit class is its first row.
const facts = computed(() => new Map(satelliteInfo.value));
const orbitClass = computed(() => facts.value.get("Orbit")?.split(" · ")[0] as OrbitClass | undefined);
const orbitColor = computed(() => (orbitClass.value ? ORBIT_CLASS_COLOR[orbitClass.value] : "transparent"));

// The three facts worth carrying in the header rather than leaving in Details:
// what regime it flies in, whose it is, whether it still works.
const chips = computed(() => ["Orbit", "Owner", "Status"].map((key) => facts.value.get(key)).filter((value): value is string => value !== undefined));

// The card title already carries the name.
const liveRows = computed(() => position.value.filter((row) => row.label !== "Name"));

const isOngoing = computed(() => !!nextPass.value && nextPass.value.start <= nowMs.value);
const ongoingFraction = computed(() => {
  const pass = nextPass.value;
  if (!pass || pass.end <= pass.start) {
    return 0;
  }
  return Math.min(1, Math.max(0, (nowMs.value - pass.start) / (pass.end - pass.start)));
});
const nextPassSubject = computed(() => (nextPass.value ? (nextPass.value.groundStationName ?? nextPass.value.name) : ""));

// A station's list is every satellite that crosses it, which is too dense to draw
// as a strip — see PassTimeline.vue.
const showTimeline = computed(() => selection.value?.kind === "satellite");

const tabs = computed(() => {
  const items: { label: string; slot: string; value: string; badge?: number }[] = [];
  if (satelliteInfo.value.length > 0 || elements.value) {
    items.push({ label: "Details", slot: "details", value: "details" });
  }
  items.push({ label: "Passes", slot: "passes", value: "passes", ...(passRows.value.length > 0 ? { badge: passRows.value.length } : {}) });
  return items;
});

/**
 * The active tab: whichever of the remembered choice and the available set can be
 * satisfied.
 *
 * Controlled rather than left to UTabs. The tab set depends on what is selected: a
 * ground station has no Details. This component is not remounted across a selection
 * change. So an uncontrolled UTabs kept pointing at a tab that had gone, and
 * rendered an empty body. What is remembered, and why, is `preferredTab`.
 */
const activeTab = computed({
  get: () => (tabs.value.some((item) => item.value === preferredTab.value) ? preferredTab.value : (tabs.value[0]?.value ?? "passes")),
  set: (value: string) => {
    preferredTab.value = value;
  },
});

// Bring the picked row into view. A block on the strip says when and how good and
// nothing else. The useful destination is the row, where the azimuth and the exact
// times are.
const tableEl = useTemplateRef<HTMLTableElement>("tableEl");
watch(pickedPassMs, (startMs) => {
  if (startMs === null) {
    return;
  }
  // After the row has its class, so `nearest` measures the right element.
  nextTick(() => {
    tableEl.value?.querySelector(`tr[data-start-ms="${startMs}"]`)?.scrollIntoView({ block: "nearest" });
  });
});

// Only a ground station has a name of its own to change; a satellite's comes from
// the catalog.
const canRename = computed(() => selection.value?.kind === "groundstation");
const renaming = ref(false);
const renameEl = useTemplateRef<HTMLInputElement>("renameEl");
/**
 * What is being typed, held locally rather than bound to the station.
 *
 * Vue patches a `:value` against the *live* DOM value, so a bound input loses what
 * was typed on every one-second refresh. Seeded from `givenName`, not the displayed
 * name: an unnamed station displays its coordinates, and that is a name with a
 * comma in it, which `wireSafeName` in the store refuses.
 */
const draftName = ref("");

// A rename in progress belongs to the station it started on.
watch(selection, () => {
  renaming.value = false;
});

function toggleRename(): void {
  if (renaming.value) {
    commitRename();
    return;
  }
  // The name it actually has, which is empty when it has none — not the coordinates
  // it falls back to displaying.
  draftName.value = selection.value?.kind === "groundstation" ? selection.value.gs.givenName : "";
  renaming.value = true;
  // Focus after the input exists, and select the text so a replacement is one
  // keystroke rather than a clear-then-type.
  nextTick(() => renameEl.value?.select());
}

function cancelRename(): void {
  renaming.value = false;
}

/**
 * Write the typed name through, then leave edit mode.
 *
 * Blur commits as well as Enter, because leaving the field is how most edits end.
 * Escape gets there first by clearing `renaming`, which is what the guard below
 * reads: the input unmounting fires one last blur, and without it Escape would
 * commit the very text it was pressed to abandon.
 *
 * Matched on the station's position in the list rather than on its old name, which
 * is the thing being changed.
 */
function commitRename(): void {
  if (!renaming.value) {
    return;
  }
  renaming.value = false;
  const sel = selection.value;
  if (sel?.kind !== "groundstation") {
    return;
  }
  const index = cc.sats.groundStations.indexOf(sel.gs);
  if (index < 0) {
    return;
  }
  satStore.setGroundStations(renamed(satStore.groundStations, index, draftName.value));
  // The write rebuilds every station entity, which drops the selection and closes
  // the panel — on the station you were in the middle of editing. Re-select the
  // replacement, which is the same list position, once it exists.
  nextTick(() => cc.sats.groundStations[index]?.select());
}

function notifyForPass(pass: Pass, aheadMin = 5): void {
  const start = dayjs(pass.start).startOf("second");
  cc.pm.notifyAtDate(start.subtract(aheadMin, "minute").toDate(), `${pass.name} pass in ${aheadMin} minutes`);
  cc.pm.notifyAtDate(start.toDate(), `${pass.name} pass starting now`);
}

function notifyPasses(): void {
  if (!cc.sats.groundStationAvailable) {
    toast.add({
      color: "warning",
      title: "Warning",
      description: "Ground station required to notify for passes",
      duration: 3000,
    });
    return;
  }
  let upcoming: Pass[] = [];
  if (selection.value?.kind === "satellite") {
    upcoming = selection.value.sat.props.passPredictor.passes(cc.viewer.clock.currentTime);
  } else if (selection.value?.kind === "groundstation") {
    upcoming = selection.value.gs.passes(cc.viewer.clock.currentTime);
  }
  if (upcoming.length === 0) {
    toast.add({
      color: "info",
      title: "Info",
      description: "No passes available",
      duration: 3000,
    });
    return;
  }
  upcoming.forEach((pass) => notifyForPass(pass));
  toast.add({
    color: "success",
    title: "Success",
    description: `Notifying for ${upcoming.length} passes`,
    duration: 3000,
  });
}
</script>

<style scoped>
.entity-info-panel {
  position: absolute;
  top: 50px;
  right: 5px;
  width: calc(100% - 10px);
  max-width: 540px;
  z-index: 5;
  font-size: 14px;
}

/*
 * The strip and the header are permanent, and the hero lives inside the body. The
 * cap is what is left of a reasonable card height. The vh term keeps the whole
 * thing on screen on a short window, where the card has no cap of its own.
 */
.entity-info-panel :deep(.info-body) {
  max-height: min(520px, 58vh);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.head__title {
  display: flex;
  align-items: center;
  gap: 4px;
}

.head__name {
  overflow: hidden;
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Sized and weighted like the name it replaces, so switching into edit mode moves
   nothing but the caret. */
.head__rename {
  min-width: 0;
  flex: 1;
  padding: 0 4px;
  border: 1px solid #ffffff40;
  border-radius: 3px;
  background: #0000004d;
  color: inherit;
  font-size: 16px;
  font-weight: 600;
}

/* Takes the slack whether or not there is a catalog number to show. */
.head__id {
  flex-grow: 1;
  color: #edffff70;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 999px;
}

.head__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding-left: 2px;
  color: #edffffb0;
  font-size: 11px;
}

.head__chips span:not(:last-child)::after {
  margin-left: 6px;
  color: #edffff60;
  content: "·";
}

/* Edge to edge, with hairline gaps: a band across the card rather than a card
   within it, which is what keeps it reading as chrome and not as content. */
.strip {
  display: flex;
  gap: 1px;
  background: #ffffff14;
}

.strip__cell {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  padding: 5px 10px;
  background: #ffffff08;
}

.strip__label {
  color: #edffff80;
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.strip__value {
  overflow: hidden;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero {
  margin-bottom: 10px;
  padding: 8px 10px 10px;
  border-radius: 4px;
  background: linear-gradient(180deg, #4caf5024, #4caf5008);
}

.hero--live {
  background: linear-gradient(180deg, #56b4e930, #56b4e910);
}

.hero__label {
  color: #edffffb0;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero__value {
  font-size: 34px;
  font-variant-numeric: tabular-nums;
  font-weight: 300;
  line-height: 1.1;
}

.hero__meta {
  margin-top: 2px;
  color: #edffffcc;
  font-size: 12.5px;
}

.hero__progress {
  margin-top: 8px;
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: #ffffff20;
}

.hero__progress span {
  display: block;
  height: 100%;
  background: #56b4e9;
}

/* The padding the scroll container gives up so its sticky table header can pin
   flush with the top edge. */
.tab-body__pad {
  padding-top: 12px;
}

/* Two states of one setting, so a pair rather than a switch: a switch would have
   to label itself with the state it is in, and "Swath: off" is not what the other
   mode is called. */
.modes {
  display: flex;
  overflow: hidden;
  border: 1px solid #ffffff2b;
  border-radius: 999px;
}

.modes__option {
  padding: 1px 8px;
  cursor: pointer;
  color: #edffff90;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.modes__option:hover {
  color: #edffff;
}

.modes__option--on {
  background: #4caf5033;
  color: #edffff;
}

.passes__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 8px 0 6px;
  color: #edffff90;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.section {
  margin: 12px 0 5px;
  color: #edffff90;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* Zebra rather than a border grid, and no coloured header bar: the bars carried no
   information, and four of them stacked is what made the panel loud. */
.info-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.info-table th,
.info-table td {
  padding: 3px 6px;
  text-align: left;
}

.info-table tbody tr:nth-child(odd) {
  background: #ffffff08;
}

.info-table--facts tbody th {
  color: #edffffb0;
  font-weight: 400;
}

/* Sticky, so the columns stay named while thirty passes scroll under them. */
.info-table thead th {
  position: sticky;
  top: 0;
  background: #383b3e;
  color: #edffffb0;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.info-table tbody tr.is-next {
  box-shadow: inset 3px 0 #4caf50;
}

.info-table tbody tr.is-picked {
  background: #edffff1f;
  box-shadow: inset -3px 0 #edffff;
}

.info-table tbody tr.is-picked.is-next {
  box-shadow:
    inset 3px 0 #4caf50,
    inset -3px 0 #edffff;
}

.num,
.right {
  text-align: right !important;
}

.mono {
  font-variant-numeric: tabular-nums;
}

.link {
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.links__item {
  padding: 2px 7px;
  border: 1px solid #ffffff2b;
  border-radius: 999px;
  color: #edffffdd;
  font-size: 11.5px;
}

.links__item:hover {
  border-color: #ffffff70;
  background: #ffffff14;
  color: #ffffff;
}

.info-code {
  margin: 0;
  padding: 4px;
  overflow-x: auto;
  background: #26262699;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.empty {
  padding: 10px 0;
  color: #edffffb0;
  text-align: center;
  font-size: 13px;
}
</style>

<!-- The orbit lab: generate a Walker pattern, and read what the sun is doing to
     it.

     One panel for two things because they are one workflow — a synthetic
     constellation exists to be analysed, and the analysis needs something with a
     known geometry to be checked against. Both halves also work alone: the
     illumination half colours the real catalog, and the generator half is just a
     constellation. -->
<template>
  <div class="orbitLab">
    <div class="toolbarTitle">Walker constellation</div>
    <p class="orbitLab__note">
      Walker notation <code>i: T/P/F</code> — T satellites in P planes, each plane offset along-track from the last by F·360°/T. Generated as circular element sets at a fixed
      epoch, so this is the pattern's geometry, not a forecast of any real constellation.
    </p>

    <button type="button" class="orbitLab__button orbitLab__button--wide" @click="twoOrbitDemo">Two-orbit demo</button>
    <p class="orbitLab__note">
      One click: two orbital planes 90° apart with one satellite each, orbit lines coloured by illumination, and the points coloured to match. The simplest scene that shows a whole
      sunlit arc, a whole eclipsed arc and the penumbra between them.
    </p>
    <p class="orbitLab__note">
      Penumbra is a sliver either way: a satellite crosses it in 10–20 s of a ~96 minute orbit, so on the arc it is a short blue tick at each eclipse boundary rather than a band.
    </p>
    <p class="orbitLab__note">
      The <code>Illumination arc</code> component is in the satellite-components menu. It stands in for the plain <code>Orbit</code> while it is on — the two are the same ellipse,
      so drawing both would z-fight.
    </p>

    <label class="orbitLab__field">
      <span>Preset</span>
      <select :value="presetIndex" @change="applyPreset(Number(($event.target as HTMLSelectElement).value))">
        <option :value="-1">Custom</option>
        <option v-for="(preset, index) in WALKER_PRESETS" :key="preset.label" :value="index">{{ preset.label }}</option>
      </select>
    </label>
    <p v-if="presetNote" class="orbitLab__note">{{ presetNote }}</p>

    <div class="orbitLab__grid">
      <label class="orbitLab__field">
        <span>Total (T)</span>
        <input v-model.number="draft.total" type="number" min="1" :max="MAX_WALKER_SATELLITES" step="1" />
      </label>
      <label class="orbitLab__field">
        <span>Planes (P)</span>
        <input v-model.number="draft.planes" type="number" min="1" step="1" />
      </label>
      <label class="orbitLab__field">
        <span>Phasing (F)</span>
        <input v-model.number="draft.phasing" type="number" min="0" step="1" />
      </label>
      <label class="orbitLab__field">
        <span>Inclination °</span>
        <input v-model.number="draft.inclinationDeg" type="number" min="0" max="180" step="0.1" />
      </label>
      <label class="orbitLab__field">
        <span>Altitude km</span>
        <input v-model.number="draft.altitudeKm" type="number" min="150" step="10" />
      </label>
      <label class="orbitLab__field">
        <span>RAAN span °</span>
        <input v-model.number="draft.raanSpanDeg" type="number" min="1" max="360" step="1" />
      </label>
    </div>

    <p class="orbitLab__derived">
      {{ perPlane }} per plane · {{ periodMinutes }} min period · {{ meanMotion }} rev/day
      <template v-if="draft.raanSpanDeg === 180"> · Walker Star (planes over 180°)</template>
    </p>
    <p v-if="validation.error" class="orbitLab__error">{{ validation.error }}</p>

    <div class="orbitLab__actions">
      <button type="button" class="orbitLab__button" :disabled="!validation.ok" @click="generate">
        {{ generatedWire === wire ? "Regenerate" : "Generate" }}
      </button>
      <button type="button" class="orbitLab__button" :disabled="!walkerActive" @click="clear">Hide</button>
    </div>
    <p v-if="generatedWire" class="orbitLab__note">
      Active: <code>{{ generatedWire }}</code> — shared in the url as <code>?walker={{ generatedWire }}</code>
    </p>

    <div class="toolbarTitle">Illumination</div>
    <p class="orbitLab__note">
      ν is the fraction of the solar disc left uncovered by the Earth (satellite.js's conical shadow model). κ is the signed cosine between the sun and an assumed solar panel
      normal — a model, not a fact: no element set carries attitude.
    </p>

    <div class="orbitLab__radios">
      <label v-for="mode in POINT_COLOR_MODES" :key="mode" class="toolbarSwitch">
        <input type="radio" name="pointColorMode" :value="mode" :checked="pointColorMode === mode" @change="pointColorMode = mode" />
        <span class="slider"></span>
        {{ POINT_COLOR_MODE_LABEL[mode] }}
      </label>
    </div>

    <label class="orbitLab__field">
      <span>Panel normal</span>
      <select :value="panelAxis" @change="panelAxis = ($event.target as HTMLSelectElement).value as PanelAxis">
        <option v-for="axis in PANEL_AXES" :key="axis" :value="axis">{{ PANEL_AXIS_LABEL[axis] }}</option>
      </select>
    </label>

    <table class="orbitLab__legend">
      <tbody>
        <tr v-for="state in ILLUMINATION_STATES" :key="state" :title="ILLUMINATION_DESCRIPTION[state]">
          <td><span class="orbitLab__swatch" :style="{ backgroundColor: ILLUMINATION_COLOR[state] }"></span></td>
          <td class="orbitLab__legendName">{{ state }}</td>
          <td class="orbitLab__legendCount">{{ census.counts[state] ?? 0 }}</td>
          <td class="orbitLab__legendShare">{{ share(census.counts[state] ?? 0) }}</td>
        </tr>
      </tbody>
    </table>
    <p class="orbitLab__derived">
      {{ census.total }} satellites on screen<template v-if="census.total > 0"> · {{ share(census.dark) }} without usable power</template>
    </p>
    <p v-if="pointColorMode === 'class'" class="orbitLab__note">Switch the colouring to Illumination to paint these states onto the globe.</p>

    <template v-if="selected">
      <div class="toolbarTitle">{{ selected.name }}</div>
      <p class="orbitLab__derived">
        <span class="orbitLab__swatch" :style="{ backgroundColor: ILLUMINATION_COLOR[selected.state] }"></span>
        {{ selected.state }} · ν {{ selected.nu.toFixed(3) }} · κ {{ selected.kappa.toFixed(3) }} · β {{ selected.betaDeg.toFixed(1) }}°
      </p>
      <div v-if="selected.strip.length > 0" class="orbitLab__strip" :title="`${STRIP_ORBITS} orbits from now (${selected.spanMinutes} min), ${STRIP_STEP_SECONDS} s per sample`">
        <span v-for="(segment, index) in selected.strip" :key="index" :style="{ backgroundColor: segment.color, flexGrow: segment.weight }"></span>
      </div>
      <p v-if="selected.strip.length > 0" class="orbitLab__note">
        Next {{ STRIP_ORBITS }} orbits ({{ selected.spanMinutes }} min): {{ pct(selected.fractions.umbra ?? 0) }} umbra · {{ pct(selected.fractions.penumbra ?? 0) }} penumbra ·
        {{ pct(selected.fractions.sunlit_back ?? 0) }} back-facing · {{ pct(selected.darkFraction) }} dark in total
      </p>
    </template>
    <p v-else class="orbitLab__note">Click a satellite to read its ν/κ and its next orbit.</p>
  </div>
</template>

<script setup lang="ts">
import { JulianDate } from "@cesium/engine";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, reactive, ref, watch } from "vue";

import { useController } from "../composables/useController";
import {
  ILLUMINATION_COLOR,
  ILLUMINATION_DESCRIPTION,
  ILLUMINATION_STATES,
  PANEL_AXES,
  PANEL_AXIS_LABEL,
  POINT_COLOR_MODE_LABEL,
  POINT_COLOR_MODES,
  type IlluminationState,
  type PanelAxis,
} from "../config/illumination";
import { illuminationTimeline } from "../modules/util/illumination";
import {
  encodeWalker,
  MAX_WALKER_SATELLITES,
  meanMotionRevPerDay,
  satsPerPlane,
  isWalkerTag,
  validateWalkerDelta,
  WALKER_PRESETS,
  walkerTagFor,
  type WalkerDeltaParams,
} from "../modules/util/walkerDelta";
import { useSatStore } from "../stores/sat";

/** How often the census and the selected satellite's readout are recomputed. */
const REFRESH_MS = 500;

/** Sample step for the strip, in seconds. Matches illuminationTimeline's own default reasoning. */
const STRIP_STEP_SECONDS = 10;

/**
 * How many orbits the strip covers.
 *
 * Two rather than one, because one orbit cannot show what changes between them.
 * The sun moves ~0.04° an hour and the orbit plane regresses a few degrees a day,
 * so consecutive orbits are nearly but not exactly alike — and where a satellite
 * is close to entering or leaving eclipse season, two orbits is where that first
 * shows up as two visibly different halves of the strip.
 */
const STRIP_ORBITS = 2;

const cc = useController();
const satStore = useSatStore();
const { pointColorMode, panelAxis, walker } = storeToRefs(satStore);

// The form's own copy: a pattern is only handed to the globe when Generate is
// pressed, so a half-typed T never becomes a constellation. Seeded from the url's
// pattern when there is one, so a shared link opens with its own numbers in the
// fields rather than the default preset's.
const draft = reactive<WalkerDeltaParams>({ ...(WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number]).params });
const initial = walker.value ? WALKER_PRESETS.find((preset) => encodeWalker(preset.params) === walker.value)?.params : undefined;
if (initial) {
  Object.assign(draft, initial);
}

const validation = computed(() => validateWalkerDelta(draft));
const wire = computed(() => (validation.value.ok ? encodeWalker(draft) : ""));
const perPlane = computed(() => (validation.value.ok ? satsPerPlane(draft) : 0));
const meanMotion = computed(() => meanMotionRevPerDay(draft.altitudeKm).toFixed(2));
const periodMinutes = computed(() => (1440 / meanMotionRevPerDay(draft.altitudeKm)).toFixed(1));

const generatedWire = computed(() => walker.value);
const walkerActive = computed(() => satStore.enabledTags.some((tag) => isWalkerTag(tag)));

const presetIndex = computed(() => WALKER_PRESETS.findIndex((preset) => encodeWalker(preset.params) === wire.value));
const presetNote = computed(() => WALKER_PRESETS[presetIndex.value]?.note ?? "");

function applyPreset(index: number): void {
  const preset = WALKER_PRESETS[index];
  if (preset) {
    Object.assign(draft, preset.params);
  }
}

/**
 * Hand the pattern to the globe and switch its tag on, dropping any other
 * pattern's.
 *
 * Two writes rather than one, and both to the store: the pattern is what
 * sceneSync expands into element sets, and the tag is what activates them. A
 * generated constellation nobody asked to see would be a catalog entry and no
 * more, which is not what pressing Generate means.
 *
 * Replacing rather than adding, because Generate means "show me this pattern" —
 * the previous one is still in the catalog and still in the browser's group list,
 * so keeping both on screen stays one click away.
 */
function generate(): void {
  if (!validation.value.ok) {
    return;
  }
  walker.value = wire.value;
  const kept = satStore.enabledTags.filter((tag) => !isWalkerTag(tag));
  satStore.setActivation({ enabledTags: [...kept, walkerTagFor(draft)] });
}

/**
 * The whole two-orbit demo in one press.
 *
 * Four writes that only make sense together — the pattern, its tag, the components
 * that draw the arc, and the colouring that matches the points to it. Offered as
 * one button because the thing being asked for is "show me the simplest version of
 * this", and reaching it through four menus is not that. Nothing here is a mode: a
 * reader can undo any of the four afterwards.
 */
function twoOrbitDemo(): void {
  const preset = WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number];
  Object.assign(draft, preset.params);
  walker.value = encodeWalker(preset.params);
  pointColorMode.value = "illumination";
  const components = new Set([...satStore.enabledComponents, "Point", "Illumination arc"]);
  // The label is noise on a two-satellite scene whose names are 20 characters long.
  components.delete("Label");
  satStore.enabledComponents = [...components];
  const kept = satStore.enabledTags.filter((tag) => !isWalkerTag(tag));
  satStore.setActivation({ enabledTags: [...kept, walkerTagFor(preset.params)] });
}

/** Leave the records in the catalog and stop drawing them — the tag is the switch. */
function clear(): void {
  satStore.setActivation({ enabledTags: satStore.enabledTags.filter((tag) => !isWalkerTag(tag)) });
}

interface Census {
  counts: Partial<Record<IlluminationState, number>>;
  total: number;
  dark: number;
}

const census = ref<Census>({ counts: {}, total: 0, dark: 0 });

interface SelectedReadout {
  name: string;
  state: IlluminationState;
  nu: number;
  kappa: number;
  betaDeg: number;
  /** The whole strip's span, not one period. */
  spanMinutes: string;
  strip: { color: string; weight: number }[];
  fractions: Partial<Record<IlluminationState, number>>;
  darkFraction: number;
}

const selected = ref<SelectedReadout | undefined>(undefined);

/**
 * Which satellite the readout is about: the selected one, else the tracked one.
 *
 * Selection first, because clicking a satellite is the more deliberate of the two
 * — tracking is what the camera is doing, and a link can arrive with it already
 * set.
 */
function subjectSatellite() {
  const sats = cc.sats.activeSatellites;
  return sats.find((sat) => sat.isSelected) ?? sats.find((sat) => sat.isTracked);
}

/**
 * Recompute both readouts.
 *
 * On a timer rather than per frame: this walks every active satellite, and a
 * census is a number someone reads rather than an animation. Half a second is
 * under the interval at which a changing count is legible and well over the cost
 * of the walk, which is one memoized lookup per satellite (see IlluminationCache)
 * plus, for the subject only, one orbit of propagation.
 */
function refresh(): void {
  const date = JulianDate.toDate(cc.viewer.clock.currentTime);
  const axis = panelAxis.value;
  const counts: Partial<Record<IlluminationState, number>> = {};
  let total = 0;
  let dark = 0;
  for (const sat of cc.sats.activeSatellites) {
    const illumination = sat.props.illumination(date, axis);
    if (!illumination) {
      continue;
    }
    total += 1;
    counts[illumination.state] = (counts[illumination.state] ?? 0) + 1;
    if (illumination.state !== "sunlit_on" && illumination.state !== "sunlit_edge") {
      dark += 1;
    }
  }
  census.value = { counts, total, dark };

  const subject = subjectSatellite();
  if (!subject) {
    selected.value = undefined;
    return;
  }
  const now = subject.props.illumination(date, axis);
  if (!now) {
    selected.value = undefined;
    return;
  }
  const spanMinutes = subject.props.orbit.orbitalPeriod * STRIP_ORBITS;
  const timeline = illuminationTimeline(subject.props.orbit.satrec, date, spanMinutes * 60, STRIP_STEP_SECONDS, axis);
  selected.value = {
    name: subject.props.name,
    state: now.state,
    nu: now.nu,
    kappa: now.kappa,
    betaDeg: now.betaDeg,
    spanMinutes: spanMinutes.toFixed(1),
    strip: runsOf(timeline.samples.map((sample) => sample.state)),
    fractions: timeline.fractions,
    darkFraction: timeline.darkFraction,
  };
}

/**
 * Consecutive equal states collapsed into weighted segments.
 *
 * A strip of ~570 one-sample divs is 570 elements the browser lays out on every
 * refresh; an orbit only ever has a handful of state changes, so the runs are the
 * same picture at a fraction of the DOM.
 */
function runsOf(states: IlluminationState[]): { color: string; weight: number }[] {
  const runs: { color: string; weight: number }[] = [];
  for (const state of states) {
    const last = runs[runs.length - 1];
    const color = ILLUMINATION_COLOR[state];
    if (last && last.color === color) {
      last.weight += 1;
    } else {
      runs.push({ color, weight: 1 });
    }
  }
  return runs;
}

/** A census count as a percentage of what is on screen. */
function share(count: number): string {
  const total = census.value.total;
  return total === 0 ? "0%" : `${((count / total) * 100).toFixed(0)}%`;
}

/** An already-normalized fraction as a percentage. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

const timer = window.setInterval(refresh, REFRESH_MS);
refresh();
onUnmounted(() => window.clearInterval(timer));

// The axis is the one input the memoized readouts cannot notice on their own
// between ticks, so a change to it is answered immediately rather than at the next
// interval.
watch(panelAxis, () => refresh());
</script>

<style scoped>
.orbitLab {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.orbitLab__note {
  margin: 0;
  font-size: 11px;
  line-height: 1.35;
  opacity: 0.7;
}

.orbitLab__derived {
  margin: 0;
  font-size: 11px;
  opacity: 0.9;
}

.orbitLab__error {
  margin: 0;
  font-size: 11px;
  color: #d55e00;
}

.orbitLab__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 8px;
}

.orbitLab__field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
}

.orbitLab__field input,
.orbitLab__field select {
  width: 88px;
  min-width: 0;
  padding: 1px 3px;
  color: inherit;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
}

.orbitLab__field select {
  width: 128px;
}

.orbitLab__actions {
  display: flex;
  gap: 6px;
}

.orbitLab__button {
  flex: 1;
  padding: 2px 6px;
  font-size: 12px;
  color: inherit;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
  cursor: pointer;
}

.orbitLab__button--wide {
  width: 100%;
}

.orbitLab__button:disabled {
  cursor: default;
  opacity: 0.4;
}

.orbitLab__radios {
  display: flex;
  flex-direction: column;
}

.orbitLab__legend {
  width: 100%;
  font-size: 11px;
  border-collapse: collapse;
}

.orbitLab__legendName {
  width: 100%;
}

.orbitLab__legendCount,
.orbitLab__legendShare {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.orbitLab__legendShare {
  padding-left: 6px;
  opacity: 0.7;
}

.orbitLab__swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 4px;
  border: 1px solid rgba(0, 0, 0, 0.5);
  border-radius: 2px;
  vertical-align: middle;
}

/* One orbit as a strip of colour, so the state changes are countable at a glance. */
.orbitLab__strip {
  display: flex;
  height: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 2px;
}

/* A state that happens at all is never invisible.
   A penumbra crossing is 10–20 s of a ~96 minute orbit, so proportionally it is a
   third of a pixel — and "0.3% penumbra" printed under a strip with no blue in it
   reads as a bug. Two pixels overstates a sliver's width and understates nothing
   else; the percentages beside the strip are what carry the real proportions. */
.orbitLab__strip > span {
  flex-basis: 0;
  min-width: 2px;
}
</style>

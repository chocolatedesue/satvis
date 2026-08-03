<!--
  The in-browser half of the benchmarking framework (see
  src/modules/benchmark/README.md): a live readout of what the globe is costing
  right now, and a sweep over satellite counts × component sets × clock rates.

  Plain CSS rather than Nuxt UI, and a dense monospace layout: this is an
  instrument, and it has to fit a dozen numbers where a card would fit two.

  The title bar and the live readout are pinned and only the rest scrolls — the
  same frame-and-scrolling-body shape the entity info panel uses. Watching a
  figure while scrolling to the control that changes it is the whole job.

  Opening it switches render-on-demand off, because with it on the gap between
  frames measures how idle the loop is and every figure here would be meaningless.
  Closing it puts that back.

  Every number here comes from the same handle the console uses
  (`window.bench`), so the panel and `bench.log()` cannot disagree.
-->
<template>
  <div class="bench" :class="{ 'bench--below-fps': showFps }">
    <div class="bench__bar">
      <span class="bench__title">BENCHMARK</span>
      <button type="button" class="bench__x" title="Close" @click="emit('close')">×</button>
    </div>

    <!-- Pinned with the readout it invalidates rather than filed away in the
         body: opening the panel switches render-on-demand off, so seeing this at
         all means something switched it back on, and every figure below is the
         gap between requested frames instead of a frame rate. -->
    <div v-if="renderOnDemand" class="bench__alert">
      render-on-demand is on — these are gaps between requested frames, not a frame rate.
      <button type="button" @click="disableRenderOnDemand()">turn off</button>
    </div>

    <div class="bench__live">
      <div class="bench__row bench__row--big">
        <span :class="['bench__fps', fpsClass]">{{ live.fps.toFixed(1) }}</span>
        <span class="bench__unit">fps</span>
        <span class="bench__sep">·</span>
        <span
          >frame <b>{{ live.frameMs.toFixed(2) }}</b> ms</span
        >
        <span class="bench__sep">·</span>
        <span
          >cpu <b>{{ live.cpuMs.toFixed(2) }}</b> ms</span
        >
        <template v-if="live.gpuMs !== undefined">
          <span class="bench__sep">·</span>
          <span
            >gpu <b>{{ live.gpuMs.toFixed(2) }}</b> ms</span
          >
        </template>
      </div>
      <div class="bench__row bench__dim">
        <!-- The window's low-water mark, and raw: a live instrument, not a report
             row. The fit is what turns heap into something comparable. -->
        p95 {{ live.p95Ms.toFixed(2) }} · worst {{ live.worstMs.toFixed(2) }} · jank {{ live.jankPct.toFixed(0) }}% · heap
        {{ live.heapMb === undefined ? "n/a" : `${live.heapMb.toFixed(0)} MB` }}
      </div>
      <div class="bench__row bench__dim">
        {{ live.satellites }} sats · {{ live.components || "no components" }} · ×{{ live.clock }} · {{ live.entities }} entities · {{ live.primitives }} primitives
      </div>
    </div>

    <div class="bench__body">
      <div class="bench__block">
        <!-- Collapsible, because the settings are touched once and the results
             are read many times. Run, Cancel and the status line stay out of the
             fold: they are what the panel is doing rather than how it was asked
             to do it, and hiding a running sweep's Cancel button would be a trap.
             The summary keeps the collapsed settings legible, so folding them
             away never means forgetting what is about to run. -->
        <button type="button" class="bench__fold" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">
          <span class="bench__chevron">{{ settingsOpen ? "▾" : "▸" }}</span>
          settings
          <span v-if="!settingsOpen" class="bench__dim">{{ settingsSummary }}</span>
        </button>
        <template v-if="settingsOpen">
          <label class="bench__field">
            <span>counts</span>
            <input v-model="countsText" type="text" spellcheck="false" :disabled="running" />
          </label>
          <div class="bench__field">
            <span>sat comps</span>
            <div class="bench__modes">
              <label v-for="option in MODES" :key="option.value" class="bench__mode" :title="option.hint">
                <input v-model="mode" type="radio" :value="option.value" :disabled="running" />
                {{ option.label }}
              </label>
            </div>
          </div>
          <!-- The propagation axis. Drawing does not care what the clock is doing;
               the sampled trajectory refreshes on a simulation-time schedule, so a
               faster clock re-propagates the same satellites more often. -->
          <label class="bench__field">
            <span>clock</span>
            <input v-model="clocksText" type="text" spellcheck="false" :disabled="running" />
            <span class="bench__dim">×</span>
          </label>
          <div class="bench__field">
            <span>timing</span>
            <div class="bench__inline">
              <label>warmup <input v-model.number="warmupMs" type="number" min="0" step="250" :disabled="running" /></label>
              <label>sample <input v-model.number="sampleMs" type="number" min="250" step="250" :disabled="running" /></label>
              <span class="bench__dim">ms</span>
            </div>
          </div>
          <div class="bench__field">
            <span>extras</span>
            <div class="bench__inline">
              <label><input v-model="withGroundStation" type="checkbox" :disabled="running" /> ground station (pass prediction)</label>
              <!-- The expensive one. Disabled rather than hidden when it cannot
                   work, because "not cross-origin isolated" is a fact about how the
                   page was served that nothing else in the app ever surfaces. -->
              <label :title="footprintHint">
                <input v-model="withFootprint" type="checkbox" :disabled="running || !footprintAvailable" />
                accurate memory footprint (measureUAM, ~17 s/step)
              </label>
            </div>
          </div>
        </template>
        <div class="bench__row">
          <button type="button" class="bench__run" :disabled="running || plan.length === 0" @click="void start()">Run {{ plan.length }} steps</button>
          <button type="button" :disabled="!running" @click="cancel()">Cancel</button>
          <span class="bench__dim">≈ {{ estimateText }}</span>
        </div>
        <div class="bench__row bench__dim">{{ status }}</div>
      </div>

      <!-- Above the tables, not beside the rows: the fits and the propagation
         deltas are built out of these rows, so a thin sample makes every table
         below noise and each one would otherwise read as a result. -->
      <div v-if="thin > 0" class="bench__block bench__warn">
        {{ thin }}/{{ rows.length }} steps sampled under {{ MIN_TRUSTWORTHY_FRAMES }} frames — those rows, and everything derived from them, are noise. Keep the tab in front.
      </div>

      <div v-if="rows.length > 0" class="bench__block bench__block--table">
        <table class="bench__table">
          <thead>
            <tr>
              <th class="bench__num">sats</th>
              <th class="bench__num">vis</th>
              <th v-if="clockSwept" class="bench__num">clock</th>
              <th class="bench__num">fps</th>
              <th class="bench__num">frame</th>
              <th class="bench__num">p95</th>
              <th class="bench__num">cpu</th>
              <th v-if="gpuColumn" class="bench__num">gpu</th>
              <th class="bench__num">build</th>
              <th v-if="footprintColumn" class="bench__num">footprint</th>
              <th>components</th>
            </tr>
          </thead>
          <tbody>
            <!-- A row averaged over a handful of frames is struck through rather
               than dropped: that it was attempted and came back worthless is
               itself the finding. -->
            <tr v-for="(row, index) in rows" :key="index" :class="{ bench__thin: row.frames < MIN_TRUSTWORTHY_FRAMES }">
              <td class="bench__num">{{ row.sats }}</td>
              <td class="bench__num">{{ row.visible }}</td>
              <td v-if="clockSwept" class="bench__num">×{{ row.clock }}</td>
              <td :class="['bench__num', row.fps < FPS_BAD ? 'bench__bad' : row.fps < FPS_WARN ? 'bench__warn' : '']" :title="`${row.frames} frames sampled`">
                {{ row.fps.toFixed(1) }}
              </td>
              <td class="bench__num">{{ row.frameMs.toFixed(2) }}</td>
              <td class="bench__num">{{ row.p95Ms.toFixed(2) }}</td>
              <td class="bench__num">{{ row.cpuMs.toFixed(2) }}</td>
              <td v-if="gpuColumn" class="bench__num">{{ row.gpuMs === "" ? "—" : row.gpuMs.toFixed(2) }}</td>
              <td class="bench__num">{{ row.buildMs.toFixed(0) }}</td>
              <td v-if="footprintColumn" class="bench__num">{{ row.footprintMb === "" ? "—" : row.footprintMb }}</td>
              <td>
                {{ row.components }}<span v-if="row.drawn" class="bench__warn"> → drew {{ row.drawn }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="fits.length > 0" class="bench__block bench__block--table">
        <div class="bench__caption">scaling (main-thread ms per 1,000 satellites; floor is GPU plus vsync)</div>
        <table class="bench__table">
          <thead>
            <tr>
              <th>series</th>
              <th class="bench__num">ms/1k</th>
              <th class="bench__num">base</th>
              <th class="bench__num">r²</th>
              <th class="bench__num">floor</th>
              <th class="bench__num">sats@60</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="fit in fits" :key="fit.series">
              <td>{{ fit.series }}</td>
              <td class="bench__num">{{ fit.mainMsPer1000.toFixed(2) }}</td>
              <td class="bench__num">{{ fit.baseMainMs.toFixed(2) }}</td>
              <td :class="['bench__num', fit.r2 < 0.9 ? 'bench__warn' : '']">{{ fit.r2.toFixed(3) }}</td>
              <td class="bench__num">{{ fit.floorMs.toFixed(2) }}</td>
              <td class="bench__num">{{ fit.satsAt60fps === "" ? "—" : fit.satsAt60fps }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Slopes only, and captioned as relative on purpose. The heap floor these
         are fitted through includes uncollected garbage, so the intercept is not a
         footprint and an absolute figure printed here would invite exactly the
         misreading that sent someone after a leak that did not exist. -->
      <div v-if="memory.length > 0" class="bench__block bench__block--table">
        <div class="bench__caption">memory (heap growth per 1,000 satellites — relative; within 2% of a forced GC when r² holds)</div>
        <table class="bench__table">
          <thead>
            <tr>
              <th>series</th>
              <th class="bench__num">MB/1k</th>
              <th class="bench__num">KB/sat</th>
              <th v-if="footprintColumn" class="bench__num" title="The same slope from absolute footprints, with its own r². Agreement with KB/sat means both can be trusted.">
                absolute
              </th>
              <th class="bench__num">r²</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="fit in memory" :key="fit.series">
              <td>{{ fit.series }}</td>
              <!-- Em dash rather than 0: a series with one count, or a browser with no
                   heap reading, has no derived slope — but may still have an absolute
                   one beside it. -->
              <td class="bench__num">{{ fit.mbPer1000Sats?.toFixed(1) ?? "—" }}</td>
              <td class="bench__num">{{ fit.kbPerSatellite?.toFixed(1) ?? "—" }}</td>
              <td v-if="footprintColumn" :class="['bench__num', fit.absoluteKbPerSatellite === undefined ? '' : absoluteFitTrustworthy(fit) ? 'bench__good' : 'bench__bad']">
                {{ fit.absoluteKbPerSatellite === undefined ? "—" : fit.absoluteKbPerSatellite.toFixed(1) }}
              </td>
              <td :class="['bench__num', fit.r2 === undefined ? '' : memoryFitTrustworthy(fit) ? 'bench__good' : 'bench__bad']">{{ fit.r2?.toFixed(3) ?? "—" }}</td>
            </tr>
          </tbody>
        </table>
        <!-- Not a footnote: a collection landing mid-series makes the slope
             meaningless rather than merely noisy, and a negative one reads as an
             answer. Measured, a broken series fitted r² 0.002 against 0.999 for a
             good one. The numbers still render — striking them out would hide the
             negative slope that is the tell — so the r² cell turns red and this
             line says what it means. -->
        <div v-if="memory.some((fit) => fit.r2 !== undefined && !memoryFitTrustworthy(fit))" class="bench__row bench__bad">
          that slope cannot be read — it needs {{ MIN_MEMORY_FIT_POINTS }}+ counts and r² {{ MIN_TRUSTWORTHY_MEMORY_R2 }}, or a garbage collection landed inside the series and its
          offset is not common to the rows. Sweep more counts, or re-run.
        </div>
      </div>

      <!-- Only when the clock was swept: an empty table here would read as
         "propagation is free" rather than "nobody asked". -->
      <div v-if="propagation.length > 0" class="bench__block bench__block--table">
        <div class="bench__caption">propagation (clock-tick ms over the same scene at ×1)</div>
        <table class="bench__table">
          <thead>
            <tr>
              <th class="bench__num">sats</th>
              <th class="bench__num">clock</th>
              <th class="bench__num">tick</th>
              <th class="bench__num">Δ</th>
              <th class="bench__num">µs/sat</th>
              <th class="bench__num">cpu</th>
              <th>components</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(cost, index) in propagation" :key="index">
              <td class="bench__num">{{ cost.sats }}</td>
              <td class="bench__num">×{{ cost.clock }}</td>
              <td class="bench__num">{{ cost.tickMs.toFixed(2) }}</td>
              <td class="bench__num">{{ cost.deltaTickMs.toFixed(2) }}</td>
              <td class="bench__num">{{ cost.usPerSatellite.toFixed(1) }}</td>
              <td class="bench__num">{{ cost.cpuMs.toFixed(2) }}</td>
              <td>{{ cost.components }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- The first step, re-run once the sweep is over. Its own table because it
         says something about the run rather than about a scene: if this scene
         measured differently the second time, the app moved under the sweep and
         every trend above is partly that. -->
      <div v-if="repeats.length > 0" class="bench__block bench__block--table">
        <div class="bench__caption">first step re-run at the end (drift)</div>
        <table class="bench__table">
          <thead>
            <tr>
              <th class="bench__num">sats</th>
              <th class="bench__num">cpu 1st</th>
              <th class="bench__num">cpu again</th>
              <th class="bench__num">drift</th>
              <th class="bench__num">build 1st</th>
              <th class="bench__num">build again</th>
              <th class="bench__num">drift</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(check, index) in repeats" :key="index">
              <td class="bench__num">{{ check.sats }}</td>
              <td class="bench__num">{{ check.firstCpuMs.toFixed(2) }}</td>
              <td class="bench__num">{{ check.repeatCpuMs.toFixed(2) }}</td>
              <td :class="['bench__num', Math.abs(check.cpuDriftPct) > MAX_TRUSTWORTHY_DRIFT_PCT ? 'bench__bad' : 'bench__good']">{{ signed(check.cpuDriftPct) }}</td>
              <td class="bench__num">{{ check.firstBuildMs.toFixed(0) }}</td>
              <td class="bench__num">{{ check.repeatBuildMs.toFixed(0) }}</td>
              <td class="bench__num">{{ signed(check.buildDriftPct) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="bench__block bench__row">
        <button type="button" :disabled="rows.length === 0" @click="logToConsole()">Log</button>
        <button type="button" :disabled="rows.length === 0" @click="void copy('csv')">Copy CSV</button>
        <button type="button" :disabled="rows.length === 0" @click="void copy('json')">Copy JSON</button>
        <button type="button" :disabled="rows.length === 0" @click="void copy('text')">Copy table</button>
        <span v-if="copied" class="bench__dim">{{ copied }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import { useController } from "../composables/useController";
import {
  CUMULATIVE_COMPONENT_SETS,
  DEFAULT_OPTIONS,
  DEFAULT_SATELLITE_COUNTS,
  ISOLATED_COMPONENT_SETS,
  buildPlan,
  canMeasureFootprint,
  estimateDurationMs,
  FOOTPRINT_CAPTURE_MS,
  formatComponents,
  installBenchmark,
  logRun,
  marginalCosts,
  memoryFits,
  propagationCosts,
  reportRows,
  scalingFits,
  repeatChecks,
  toCsv,
  toJson,
  formatTable,
  GPU_TIMER_TRUST_FACTOR,
  MAX_TRUSTWORTHY_DRIFT_PCT,
  MIN_MEMORY_FIT_POINTS,
  MIN_TRUSTWORTHY_FRAMES,
  MIN_TRUSTWORTHY_MEMORY_R2,
  absoluteFitTrustworthy,
  hasFootprints,
  memoryFitTrustworthy,
  type BenchmarkRun,
  type MemoryFit,
  type PropagationCost,
  type RepeatCheck,
  type ReportRow,
  type ScalingFit,
} from "../modules/benchmark";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";

const emit = defineEmits<{ close: [] }>();

const cc = useController();
const cesiumStore = useCesiumStore();
const satStore = useSatStore();
// Both reactive now that the store owns them, which is what lets the warning
// appear the moment someone switches render-on-demand back on, and the panel
// step aside only for an FPS counter that is actually drawn.
const { showFps, requestRenderMode: renderOnDemand } = storeToRefs(cesiumStore);
// Opening the panel is what installs the framework, which is also what puts
// `window.bench` there. Idempotent, so a second open reuses the same handle and
// the console and the panel are never measuring different things.
const bench = installBenchmark(cc);

// `current` first and selected: the everyday question is how the components the
// user actually has switched on scale, and it is also the only choice that costs
// one pass rather than seven or eight.
const MODES = [
  { value: "current", label: "current", hint: "Only the components currently switched on" },
  { value: "isolated", label: "isolated", hint: "Point, plus each other component on its own" },
  { value: "cumulative", label: "cumulative", hint: "One component added at a time, on top of the last" },
] as const;
type Mode = (typeof MODES)[number]["value"];

const countsText = ref(DEFAULT_SATELLITE_COUNTS.join(", "));
// Real time only by default: the clock axis multiplies the step count, and most
// sessions are asking about drawing rather than about propagation.
const clocksText = ref("1");
const mode = ref<Mode>("current");
const warmupMs = ref(DEFAULT_OPTIONS.warmupMs);
const sampleMs = ref(DEFAULT_OPTIONS.sampleMs);
/** Below this a row is red; below FPS_WARN it is yellow. 60 is the budget the scaling table extrapolates to. */
const FPS_BAD = 30;
const FPS_WARN = 60;

const withGroundStation = ref(false);
/**
 * Off by default, and the estimate is what keeps that honest: a capture waits
 * about 17 s for a collection, so on the default sweep this is four minutes
 * against fourteen.
 */
const withFootprint = ref(false);
const footprintAvailable = canMeasureFootprint();
const footprintHint = footprintAvailable
  ? "performance.measureUserAgentSpecificMemory(): an absolute footprint with garbage excluded, against the relative slope the default reports. It resolves only when a collection happens, which is the ~17 s."
  : "Unavailable: this page is not cross-origin isolated, so the API is not exposed. pnpm dev and pnpm preview send the headers that enable it; a deployed satvis.space does not.";
const running = ref(false);
const status = ref("idle");
const copied = ref("");
// Open to begin with: the settings are the first thing anyone touches, and a
// panel that opens showing nothing but a Run button hides what it would run.
const settingsOpen = ref(true);
// Bumped as each row lands so the tables recompute off the live run object,
// which the runner mutates in place rather than replacing.
const revision = ref(0);
const finished = ref<BenchmarkRun | undefined>(undefined);

const counts = computed(() =>
  countsText.value
    .split(/[\s,]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value) && value >= 0),
);

const componentSets = computed<readonly (readonly string[])[]>(() => {
  switch (mode.value) {
    case "cumulative":
      return CUMULATIVE_COMPONENT_SETS;
    case "current":
      return [[...satStore.enabledComponents]];
    default:
      return ISOLATED_COMPONENT_SETS;
  }
});

const clocks = computed(() =>
  clocksText.value
    .split(/[\s,x×]+/)
    .map((part) => Number.parseFloat(part))
    .filter((value) => Number.isFinite(value) && value > 0),
);

const spec = computed(() => ({ satelliteCounts: counts.value, componentSets: componentSets.value, clockMultipliers: clocks.value }));
const plan = computed(() => buildPlan(spec.value));

const estimateText = computed(() => {
  const seconds = Math.round(estimateDurationMs(plan.value, warmupMs.value + sampleMs.value, withFootprint.value ? FOOTPRINT_CAPTURE_MS : 0) / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
});

/** What the folded settings say, so collapsing them is not the same as losing them. */
/**
 * Point the controls at what a run is actually doing.
 *
 * `mode` is reverse-mapped rather than stored: the spec carries component sets, and
 * whether they came from a preset is only recoverable by comparing against the
 * presets. Anything unrecognised is "current", which is what a hand-passed
 * `componentSets` most resembles.
 */
function adoptRunSettings(): void {
  const current = run();
  if (!current) {
    return;
  }
  const sameSets = (a: readonly (readonly string[])[], b: readonly (readonly string[])[]): boolean =>
    a.length === b.length && a.every((set, index) => set.join("|") === (b[index] ?? []).join("|"));
  const sets = current.spec.componentSets;
  mode.value = sameSets(sets, ISOLATED_COMPONENT_SETS) ? "isolated" : sameSets(sets, CUMULATIVE_COMPONENT_SETS) ? "cumulative" : "current";
  countsText.value = [...current.spec.satelliteCounts].join(", ");
  clocksText.value = (current.spec.clockMultipliers ?? [1]).join(", ");
  warmupMs.value = current.options.warmupMs;
  sampleMs.value = current.options.sampleMs;
  withFootprint.value = current.options.captureFootprint === true;
  withGroundStation.value = bench.target.options.groundStation !== undefined;
}

const settingsSummary = computed(() => {
  const parts = [`${counts.value.length} counts`, mode.value];
  if (clocks.value.length > 1 || (clocks.value[0] ?? 1) !== 1) {
    parts.push(`${clocks.value.length} clocks`);
  }
  if (withGroundStation.value) {
    parts.push("ground station");
  }
  if (withFootprint.value) {
    // Named in the collapsed summary because it is the setting that turns a
    // four-minute sweep into a fourteen-minute one.
    parts.push("footprint");
  }
  return `· ${parts.join(" · ")}`;
});

const run = (): BenchmarkRun | undefined => bench.runner.run ?? finished.value;

// The runner mutates one run object in place rather than replacing it, so a
// computed over `run` would settle on the same reference and never invalidate —
// which is exactly what kept the results table empty. Every derived view reads
// the revision counter directly instead, and `run` stays a plain function so
// there is no second, staler copy of it to depend on by accident.
const rows = computed<ReportRow[]>(() => {
  void revision.value;
  const current = run();
  return current ? reportRows(current) : [];
});
const fits = computed<ScalingFit[]>(() => {
  void revision.value;
  const current = run();
  return current && current.results.length > 1 ? scalingFits(current) : [];
});
const memory = computed<MemoryFit[]>(() => {
  void revision.value;
  const current = run();
  return current && current.results.length > 1 ? memoryFits(current) : [];
});
const propagation = computed<PropagationCost[]>(() => {
  void revision.value;
  const current = run();
  return current ? propagationCosts(current) : [];
});
const repeats = computed<RepeatCheck[]>(() => {
  void revision.value;
  const current = run();
  return current ? repeatChecks(current) : [];
});

const signed = (percent: number): string => `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;

/**
 * Whether the clock column earns its width — asked of the rows on screen, not of
 * the form. Reading the form instead hid the column on a sweep started from the
 * console, which left three rows differing only in a value that was not shown.
 */
const clockSwept = computed(() => new Set(rows.value.map((row) => row.clock)).size > 1 || rows.value.some((row) => row.clock !== 1));

/** Any row too thin to mean anything taints the derived tables built on top of it. */
const thin = computed(() => rows.value.filter((row) => row.frames < MIN_TRUSTWORTHY_FRAMES).length);

/**
 * Only give the column its width when some row actually carries a figure — the
 * report blanks every one of them together when the driver's clock cannot be
 * believed, and a column of dashes says nothing a missing column does not.
 */
const gpuColumn = computed(() => rows.value.some((row) => row.gpuMs !== ""));

/**
 * Same rule as gpuColumn: shown only where a run actually captured footprints. Via
 * the shared predicate, so this and `logRun` cannot disagree about whether a run
 * has any.
 */
const footprintColumn = computed(() => {
  void revision.value;
  const current = run();
  return current !== undefined && hasFootprints(current);
});

// --- live readout ----------------------------------------------------------
interface Live {
  fps: number;
  frameMs: number;
  p95Ms: number;
  worstMs: number;
  cpuMs: number;
  /** Undefined where there is no GPU clock, or one that contradicts the frame rate. */
  gpuMs: number | undefined;
  jankPct: number;
  /** The window's low-water mark — the live-set estimate. Undefined outside Chrome. */
  heapMb: number | undefined;
  satellites: number;
  components: string;
  clock: number;
  entities: number;
  primitives: number;
}
const EMPTY_LIVE: Live = {
  fps: 0,
  frameMs: 0,
  p95Ms: 0,
  worstMs: 0,
  cpuMs: 0,
  gpuMs: undefined,
  jankPct: 0,
  heapMb: undefined,
  satellites: 0,
  components: "",
  clock: 1,
  entities: 0,
  primitives: 0,
};
const live = ref<Live>(EMPTY_LIVE);

const fpsClass = computed(() => (live.value.fps < FPS_BAD ? "bench__bad" : live.value.fps < FPS_WARN ? "bench__warn" : "bench__good"));

const gpuOrUndefined = (gpuMs: number | undefined, wallP50: number | undefined): number | undefined =>
  gpuMs !== undefined && wallP50 !== undefined && wallP50 > 0 && gpuMs <= wallP50 * GPU_TIMER_TRUST_FACTOR ? gpuMs : undefined;

/** The warning's own way out, so the fix is where the complaint is. */
function disableRenderOnDemand(): void {
  cesiumStore.requestRenderMode = false;
}

let timer: ReturnType<typeof setInterval> | undefined;

function refresh(): void {
  // Read from the shared runner rather than tracking it locally, so a sweep
  // started from the console fills this table too and cannot leave the panel
  // offering a Run button that would throw. Bumping the revision here is what
  // makes the tables follow a run nobody in this component started.
  const wasRunning = running.value;
  running.value = bench.runner.running;
  if (!startedHere) {
    // A console-driven run has no hooks into this component, so its start *and*
    // its end have to be noticed here — otherwise the panel goes on saying
    // "running" over a finished run's results.
    if (running.value) {
      status.value = "running — started from the console";
      // A console run bypasses these controls, so they would otherwise go on
      // describing whatever was last typed while a different sweep ran. Adopting
      // the run's own spec keeps the panel an honest account of what is happening.
      adoptRunSettings();
    } else if (wasRunning) {
      const finishedRun = bench.runner.run;
      status.value = finishedRun ? `done — ${finishedRun.results.length} steps (console)` : "idle";
    }
  }
  revision.value += 1;
  const snapshot = bench.target.live();
  live.value = {
    fps: snapshot.frames.fps,
    frameMs: snapshot.frames.wall?.mean ?? 0,
    p95Ms: snapshot.frames.wall?.p95 ?? 0,
    worstMs: snapshot.frames.wall?.max ?? 0,
    cpuMs: snapshot.frames.cpu?.mean ?? 0,
    // The same invariant the report applies per run, applied here per snapshot:
    // a frame that presented every N ms cannot have cost the GPU much more than
    // N, so a timer claiming otherwise is measuring something else.
    gpuMs: gpuOrUndefined(snapshot.frames.gpu?.mean, snapshot.frames.wall?.p50),
    jankPct: snapshot.frames.jankRatio * 100,
    heapMb: snapshot.frames.heap?.min,
    satellites: snapshot.satellitesVisible,
    components: formatComponents(snapshot.componentsDrawn),
    clock: snapshot.clockMultiplier,
    entities: snapshot.entities,
    primitives: snapshot.primitives,
  };
}

// What render-on-demand was before the panel took it away, so closing gives it
// back. Held here rather than in the target: this is the panel's doing, and the
// target's own save/restore is scoped to a run.
let savedRequestRenderMode: boolean | undefined;

onMounted(() => {
  // Render-on-demand skips frames whenever nothing moved, which makes the gap
  // between frames a measure of how idle the loop is rather than of what a scene
  // costs — so every figure in this panel would be meaningless while it is on.
  // Switched off on open rather than offered as a button: there is no reading to
  // be had with it on, so there was nothing for the button to be a choice
  // between.
  //
  // Through the store, not `scene.requestRenderMode`. Writing the scene left the
  // Render menu's own RequestRender switch showing the old value — a plain scene
  // property is not reactive — so the first time the panel was opened it looked
  // as though nothing had happened.
  savedRequestRenderMode = cesiumStore.requestRenderMode;
  cesiumStore.requestRenderMode = false;
  refresh();
  // Twice a second: often enough to read as live, rarely enough that reading it
  // is not itself part of what is being measured.
  timer = setInterval(refresh, 500);
});
onUnmounted(() => {
  if (timer !== undefined) {
    clearInterval(timer);
  }
  if (savedRequestRenderMode !== undefined) {
    cesiumStore.requestRenderMode = savedRequestRenderMode;
  }
});

// --- the sweep -------------------------------------------------------------
// Whether this panel is the one driving, which is the difference between a
// step-by-step status line and merely saying that something is under way.
let startedHere = false;

async function start(): Promise<void> {
  startedHere = true;
  running.value = true;
  finished.value = undefined;
  status.value = "preparing — loading the whole catalog";
  try {
    const result = await bench.runner.start(
      spec.value,
      { warmupMs: warmupMs.value, sampleMs: sampleMs.value, captureFootprint: withFootprint.value },
      {
        onProgress: ({ done, total, step }) => {
          status.value = `${done + 1}/${total} — ${step.label}`;
          revision.value += 1;
        },
        onResult: () => {
          revision.value += 1;
        },
      },
    );
    finished.value = result;
    status.value = result.cancelled ? `cancelled after ${result.results.length} steps` : `done — ${result.results.length} steps`;
    logRun(result);
  } catch (error) {
    status.value = `failed: ${String(error)}`;
  } finally {
    startedHere = false;
    running.value = false;
    revision.value += 1;
  }
}

function cancel(): void {
  bench.runner.cancel();
  status.value = "cancelling — finishing the current sample";
}

function logToConsole(): void {
  const current = run();
  if (current) {
    logRun(current);
    console.table(marginalCosts(current));
  }
}

async function copy(format: "csv" | "json" | "text"): Promise<void> {
  const current = run();
  if (!current) {
    return;
  }
  const text = format === "csv" ? toCsv(current) : format === "json" ? toJson(current) : formatTable(current);
  try {
    await navigator.clipboard.writeText(text);
    copied.value = `copied ${format}`;
  } catch {
    console.log(text);
    copied.value = "clipboard refused — logged instead";
  }
  setTimeout(() => {
    copied.value = "";
  }, 2000);
}

// The ground station lives on the shared target rather than being passed per
// run: it is a property of the scene being measured, not of the sweep. Munich,
// because the observer only has to be somewhere for passes to be computed.
watch(
  withGroundStation,
  (enabled) => {
    // Merged, not replaced: a console run may have set `tag` to pin the population,
    // and replacing the object would silently drop it — including when the panel
    // adopts a console run's settings and this watcher fires as a side effect.
    bench.target.options = { ...bench.target.options, groundStation: enabled ? { lat: 48.1772, lon: 11.7476 } : undefined };
  },
  { immediate: true },
);
</script>

<style scoped>
/* Top right, on the entity info panel's own coordinates so the two read as one
   slot. */
.bench {
  position: fixed;
  top: 50px;
  right: 5px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  width: 480px;
  max-width: calc(100vw - 10px);
  max-height: calc(100vh - 60px);
  border: 1px solid #ffb000;
  border-radius: 4px;
  background: rgba(12, 14, 18, 0.94);
  color: #d8dee9;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
}

/* Cesium draws its FPS counter at top 50px / right 10px — exactly here — and it
   is the independent second opinion this panel's headline figure gets checked
   against, computed by code the framework does not own. So step below it, but
   only while it is actually on screen: giving up 60px to a counter nobody
   switched on would be paying for it twice. */
.bench--below-fps {
  top: 110px;
  max-height: calc(100vh - 120px);
}

/* The frame: bar, alert and live readout pinned, body scrolls. `min-height: 0`
   is what makes the body shrink instead of pushing the panel past its
   max-height — a flex item defaults to its content's size and would otherwise
   scroll the whole panel, taking the readout with it. */
.bench__bar,
.bench__alert,
.bench__live {
  flex: none;
}

.bench__alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: rgba(255, 176, 0, 0.15);
  border-bottom: 1px solid #ffb000;
  color: #ffb000;
}

.bench__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.bench__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: #ffb000;
  color: #16181d;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.bench__live {
  padding: 6px;
  border-bottom: 1px solid #2a2f3a;
}

/* `.bench .bench__x`, not `.bench__x`: the generic `.bench button` rule below is
   more specific than a bare class and was winning, so the close button was
   painted with the dark button background on top of the orange bar and all but
   vanished. Dark ink on the bar's own orange instead, which is the same contrast
   the title beside it has. */
.bench .bench__x {
  margin-left: auto;
  padding: 0 2px;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: #16181d;
  cursor: pointer;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
}

.bench .bench__x:hover {
  background: rgba(0, 0, 0, 0.25);
  color: #000;
}

.bench__block {
  padding: 6px;
  border-top: 1px solid #2a2f3a;
}

.bench__block--table {
  overflow-x: auto;
}

.bench__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.bench__row--big {
  font-size: 12px;
}

.bench__fps {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
}

.bench__unit,
.bench__sep,
.bench__dim {
  color: #7a8291;
}

.bench__good {
  color: #86c06c;
}

.bench__warn {
  color: #ffb000;
}

.bench__bad {
  color: #f07178;
}

.bench__field {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.bench__field > span:first-child {
  width: 52px;
  flex: none;
  color: #7a8291;
}

.bench__modes,
.bench__inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.bench input[type="text"],
.bench input[type="number"] {
  border: 1px solid #2a2f3a;
  border-radius: 2px;
  background: #16181d;
  color: inherit;
  font: inherit;
  padding: 1px 4px;
}

.bench input[type="text"] {
  flex: 1;
  min-width: 0;
}

.bench input[type="number"] {
  width: 56px;
}

.bench button {
  border: 1px solid #3a4150;
  border-radius: 2px;
  background: #21252e;
  color: inherit;
  font: inherit;
  padding: 2px 8px;
  cursor: pointer;
}

.bench button:disabled {
  opacity: 0.4;
  cursor: default;
}

.bench__run {
  border-color: #ffb000;
  color: #ffb000;
}

.bench__table {
  width: 100%;
  border-collapse: collapse;
  white-space: nowrap;
}

.bench__table th {
  color: #7a8291;
  font-weight: 400;
  text-align: left;
  border-bottom: 1px solid #2a2f3a;
}

.bench__table td,
.bench__table th {
  padding: 0 4px;
}

.bench__table tbody tr:nth-child(even) {
  background: rgba(255, 255, 255, 0.03);
}

.bench__thin td {
  color: #6b7280;
  text-decoration: line-through;
}

/* Beats `.bench__table th`, which sets text-align: left and outranks a bare
   `.bench__num` on specificity — that is what left a numeric header sitting over a
   right-aligned column. */
.bench__table th.bench__num {
  text-align: right;
}
.bench__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.bench__caption {
  color: #7a8291;
  margin-bottom: 2px;
}

/* Full width and left-aligned so the whole header row is the hit target, rather
   than a chevron nobody can hit. Beats `.bench button` on specificity for the
   same reason the close button has to. */
.bench .bench__fold {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-bottom: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #7a8291;
  text-align: left;
}

.bench .bench__fold:hover {
  color: #d8dee9;
}

.bench__chevron {
  width: 8px;
}
</style>

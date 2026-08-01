<!--
  PROTOTYPE — see src/modules/benchmark/README.md.

  The in-browser half of the benchmarking framework: a live readout of what the
  globe is costing right now, and a sweep over satellite counts × component sets ×
  clock rates. Deliberately plain CSS rather than Nuxt UI — a throwaway panel
  should not be arguing with the design system, and it has to be obvious on sight
  that it is not part of the app.

  Opening it switches render-on-demand off, because with it on the gap between
  frames measures how idle the loop is and every figure here would be meaningless.
  Closing it puts that back.

  Every number here comes from the same handle the console uses
  (`window.bench`), so the panel and `bench.log()` cannot disagree.
-->
<template>
  <div class="bench">
    <div class="bench__bar">
      <span class="bench__title">BENCHMARK</span>
      <span class="bench__tag">prototype</span>
      <button type="button" class="bench__x" title="Close" @click="emit('close')">×</button>
    </div>

    <div class="bench__block">
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
      </div>
      <div class="bench__row bench__dim">
        p95 {{ live.p95Ms.toFixed(2) }} · worst {{ live.worstMs.toFixed(2) }} · jank {{ live.jankPct.toFixed(0) }}% · heap
        {{ live.heapMb === undefined ? "n/a" : `${live.heapMb.toFixed(0)} MB` }}
      </div>
      <div class="bench__row bench__dim">
        {{ live.satellites }} sats · {{ live.components || "no components" }} · ×{{ live.clock }} · {{ live.entities }} entities · {{ live.primitives }} primitives
      </div>
    </div>

    <div class="bench__block">
      <label class="bench__field">
        <span>counts</span>
        <input v-model="countsText" type="text" spellcheck="false" :disabled="running" />
      </label>
      <div class="bench__field">
        <span>sets</span>
        <div class="bench__modes">
          <label v-for="option in MODES" :key="option.value" class="bench__mode">
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
        </div>
      </div>
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
            <th class="bench__num">build</th>
            <th class="bench__num">heap</th>
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
            <td :class="['bench__num', row.fps < 30 ? 'bench__bad' : row.fps < 55 ? 'bench__warn' : '']" :title="`${row.frames} frames sampled`">{{ row.fps.toFixed(1) }}</td>
            <td class="bench__num">{{ row.frameMs.toFixed(2) }}</td>
            <td class="bench__num">{{ row.p95Ms.toFixed(2) }}</td>
            <td class="bench__num">{{ row.cpuMs.toFixed(2) }}</td>
            <td class="bench__num">{{ row.buildMs.toFixed(0) }}</td>
            <td class="bench__num">{{ row.heapMb === "" ? "—" : row.heapMb }}</td>
            <td>
              {{ row.components }}<span v-if="row.drawn" class="bench__warn"> → drew {{ row.drawn }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="fits.length > 0" class="bench__block bench__block--table">
      <div class="bench__caption">scaling (cpu ms per 1,000 satellites, and where 60 fps runs out)</div>
      <table class="bench__table">
        <thead>
          <tr>
            <th>series</th>
            <th class="bench__num">ms/1k</th>
            <th class="bench__num">base</th>
            <th class="bench__num">r²</th>
            <th class="bench__num">sats@60</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="fit in fits" :key="fit.series">
            <td>{{ fit.series }}</td>
            <td class="bench__num">{{ fit.cpuMsPer1000.toFixed(2) }}</td>
            <td class="bench__num">{{ fit.baseCpuMs.toFixed(2) }}</td>
            <td :class="['bench__num', fit.r2 < 0.9 ? 'bench__warn' : '']">{{ fit.r2.toFixed(3) }}</td>
            <td class="bench__num">{{ fit.satsAt60fps === "" ? "—" : fit.satsAt60fps }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Only when the clock was swept: an empty table here would read as
         "propagation is free" rather than "nobody asked". -->
    <div v-if="propagation.length > 0" class="bench__block bench__block--table">
      <div class="bench__caption">propagation (cpu ms over the same scene at ×1)</div>
      <table class="bench__table">
        <thead>
          <tr>
            <th class="bench__num">sats</th>
            <th class="bench__num">clock</th>
            <th class="bench__num">cpu</th>
            <th class="bench__num">Δ</th>
            <th class="bench__num">µs/sat</th>
            <th>components</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(cost, index) in propagation" :key="index">
            <td class="bench__num">{{ cost.sats }}</td>
            <td class="bench__num">×{{ cost.clock }}</td>
            <td class="bench__num">{{ cost.cpuMs.toFixed(2) }}</td>
            <td class="bench__num">{{ cost.deltaCpuMs.toFixed(2) }}</td>
            <td class="bench__num">{{ cost.usPerSatellite.toFixed(1) }}</td>
            <td>{{ cost.components }}</td>
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
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import { useController } from "../composables/useController";
import {
  CUMULATIVE_COMPONENT_SETS,
  DEFAULT_OPTIONS,
  DEFAULT_SATELLITE_COUNTS,
  ISOLATED_COMPONENT_SETS,
  buildPlan,
  estimateDurationMs,
  formatComponents,
  installBenchmark,
  logRun,
  marginalCosts,
  propagationCosts,
  reportRows,
  scalingFits,
  toCsv,
  toJson,
  formatTable,
  MIN_TRUSTWORTHY_FRAMES,
  type BenchmarkRun,
  type PropagationCost,
  type ReportRow,
  type ScalingFit,
} from "../modules/benchmark";
import { useSatStore } from "../stores/sat";

const emit = defineEmits<{ close: [] }>();

const cc = useController();
const satStore = useSatStore();
// Opening the panel is what installs the framework, which is also what puts
// `window.bench` there. Idempotent, so a second open reuses the same handle and
// the console and the panel are never measuring different things.
const bench = installBenchmark(cc);

const MODES = [
  { value: "isolated", label: "isolated" },
  { value: "cumulative", label: "cumulative" },
  { value: "current", label: "current" },
] as const;
type Mode = (typeof MODES)[number]["value"];

const countsText = ref(DEFAULT_SATELLITE_COUNTS.join(", "));
// Real time only by default: the clock axis multiplies the step count, and most
// sessions are asking about drawing rather than about propagation.
const clocksText = ref("1");
const mode = ref<Mode>("isolated");
const warmupMs = ref(DEFAULT_OPTIONS.warmupMs);
const sampleMs = ref(DEFAULT_OPTIONS.sampleMs);
const withGroundStation = ref(false);
const running = ref(false);
const status = ref("idle");
const copied = ref("");
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
  const seconds = Math.round(estimateDurationMs(plan.value, warmupMs.value + sampleMs.value) / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
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
const propagation = computed<PropagationCost[]>(() => {
  void revision.value;
  const current = run();
  return current ? propagationCosts(current) : [];
});

/**
 * Whether the clock column earns its width — asked of the rows on screen, not of
 * the form. Reading the form instead hid the column on a sweep started from the
 * console, which left three rows differing only in a value that was not shown.
 */
const clockSwept = computed(() => new Set(rows.value.map((row) => row.clock)).size > 1 || rows.value.some((row) => row.clock !== 1));

/** Any row too thin to mean anything taints the derived tables built on top of it. */
const thin = computed(() => rows.value.filter((row) => row.frames < MIN_TRUSTWORTHY_FRAMES).length);

// --- live readout ----------------------------------------------------------
interface Live {
  fps: number;
  frameMs: number;
  p95Ms: number;
  worstMs: number;
  cpuMs: number;
  jankPct: number;
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
  jankPct: 0,
  heapMb: undefined,
  satellites: 0,
  components: "",
  clock: 1,
  entities: 0,
  primitives: 0,
};
const live = ref<Live>(EMPTY_LIVE);

const fpsClass = computed(() => (live.value.fps < 30 ? "bench__bad" : live.value.fps < 55 ? "bench__warn" : "bench__good"));

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
    jankPct: snapshot.frames.jankRatio * 100,
    heapMb: snapshot.heapMb,
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
  savedRequestRenderMode = cc.viewer.scene.requestRenderMode;
  cc.viewer.scene.requestRenderMode = false;
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
    cc.viewer.scene.requestRenderMode = savedRequestRenderMode;
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
      { warmupMs: warmupMs.value, sampleMs: sampleMs.value },
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
    bench.target.options = enabled ? { groundStation: { lat: 48.1772, lon: 11.7476 } } : {};
  },
  { immediate: true },
);
</script>

<style scoped>
/* Top right, on the entity info panel's own coordinates (see
   EntityInfoPanel.vue) so the two read as the same slot rather than two
   near-misses. They overlap when both are open, which is fine: they answer
   different questions and nobody needs both at once. */
.bench {
  position: fixed;
  top: 50px;
  right: 5px;
  z-index: 2000;
  width: 480px;
  max-width: calc(100vw - 10px);
  max-height: calc(100vh - 60px);
  overflow-y: auto;
  border: 1px solid #ffb000;
  border-radius: 4px;
  background: rgba(12, 14, 18, 0.94);
  color: #d8dee9;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
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

.bench__tag {
  font-weight: 400;
  text-transform: uppercase;
  opacity: 0.7;
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

.bench__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.bench__caption {
  color: #7a8291;
  margin-bottom: 2px;
}
</style>

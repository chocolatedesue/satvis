// Turning a run into the answers it was collected for: the raw rows, how the
// frame time scales with the satellite count, what each component costs on top
// of what was already being drawn, what running the clock faster costs, and
// whether the app drifted while all of that was being measured. Pure — a run in,
// strings and numbers out — so the console output and the panel's table cannot
// disagree.

import { formatComponents, formatSeries } from "./benchmarkPlan";
import type { BenchmarkResult, BenchmarkRun } from "./benchmarkRunner";

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

/** The frame time a row is judged by: the work done, not the vsync wait. */
const cpuMs = (result: BenchmarkResult): number => result.frames.cpu?.mean ?? 0;

/** What varies within a series: the component set and the clock rate together. */
const seriesOf = (result: BenchmarkResult): string => formatSeries(result.applied.componentsRequested, result.applied.clockMultiplier);

/**
 * Every derived table works off these — the closing re-run of the first step is
 * a second sample of a scene already in the set, so averaging it in would weight
 * one point twice and hide the very drift it was measured to expose.
 */
const measured = (run: BenchmarkRun): BenchmarkResult[] => run.results.filter((result) => !result.step.repeat);

/**
 * How far past the frame interval a GPU timing may sit before it is disbelieved.
 *
 * The invariant: frames present one after another, and GPU work for a frame does
 * not overlap GPU work for the next, so a frame that presents every 14 ms cannot
 * have taken 49 ms on the GPU. 1.5× leaves room for measurement noise and for a
 * genuinely GPU-bound scene (where the two converge on each other) while still
 * catching a driver that is reporting something other than execution time.
 */
export const GPU_TIMER_TRUST_FACTOR = 1.5;

/**
 * Whether this run's GPU timings can be printed.
 *
 * `EXT_disjoint_timer_query_webgl2` is present but wrong on some stacks —
 * measured on ANGLE/Metal (Apple silicon) it reported ~49 ms per frame while the
 * app was demonstrably presenting at 70 fps. Rather than print a number that is
 * three times the whole frame, the column goes blank and `logRun` says why.
 */
export function gpuTimerTrustworthy(run: BenchmarkRun): boolean {
  const pairs = run.results
    .map((result) => ({ gpu: result.frames.gpu?.p50, wall: result.frames.wall?.p50 }))
    .filter((pair): pair is { gpu: number; wall: number } => pair.gpu !== undefined && pair.wall !== undefined && pair.wall > 0);
  if (pairs.length === 0) {
    return false;
  }
  const overruns = pairs.filter((pair) => pair.gpu > pair.wall * GPU_TIMER_TRUST_FACTOR).length;
  // A single odd step is noise; a majority overrunning is the driver, not the app.
  return overruns * 2 <= pairs.length;
}

export interface ReportRow {
  sats: number;
  components: string;
  /** The clock rate, as a multiple of real time. */
  clock: number;
  /** True for the closing re-run of the first step. */
  repeat: boolean;
  /** Blank unless the app drew something other than what was asked for. */
  drawn: string;
  visible: number;
  /**
   * How many frames the row is an average of. A handful means the sample is
   * worthless — a backgrounded tab, or a scene so slow it barely presented —
   * and every other number on the row should be read as noise.
   */
  frames: number;
  fps: number;
  frameMs: number;
  p95Ms: number;
  worstMs: number;
  cpuMs: number;
  cpuP95Ms: number;
  /**
   * GPU time for one frame. Blank where the browser has no timer extension, and
   * blank where it has one that cannot be believed — see `gpuTimerTrustworthy`.
   */
  gpuMs: number | "";
  jankPct: number;
  buildMs: number;
  clearMs: number;
  entities: number;
  primitives: number;
  heapMb: number | "";
}

export function reportRows(run: BenchmarkRun): ReportRow[] {
  // Decided once per run, not per row: whether the driver's clock can be
  // believed is a property of the machine, and a column that appeared on some
  // rows and not others would read as "the GPU did nothing here".
  const trustGpu = gpuTimerTrustworthy(run);
  return run.results.map((result) => {
    const requested = formatComponents(result.applied.componentsRequested);
    const drawn = formatComponents(result.applied.componentsDrawn);
    const gpu = trustGpu ? result.frames.gpu?.mean : undefined;
    return {
      sats: result.applied.satellitesRequested,
      components: requested,
      clock: result.applied.clockMultiplier,
      repeat: result.step.repeat,
      drawn: drawn === requested ? "" : drawn,
      visible: result.applied.satellitesVisible,
      frames: result.frames.frames,
      fps: round(result.frames.fps, 1),
      frameMs: round(result.frames.wall?.mean ?? 0),
      p95Ms: round(result.frames.wall?.p95 ?? 0),
      worstMs: round(result.frames.wall?.max ?? 0),
      cpuMs: round(cpuMs(result)),
      cpuP95Ms: round(result.frames.cpu?.p95 ?? 0),
      gpuMs: gpu === undefined ? "" : round(gpu),
      jankPct: round(result.frames.jankRatio * 100, 1),
      buildMs: round(result.applied.buildMs),
      clearMs: round(result.applied.clearMs),
      entities: result.applied.entities,
      primitives: result.applied.primitives,
      heapMb: result.heapMb === undefined ? "" : round(result.heapMb, 1),
    };
  });
}

export interface ScalingFit {
  /** The component set and, where it is not real time, the clock rate. */
  series: string;
  points: number;
  /** Least-squares slope, restated per 1,000 satellites to be readable. */
  cpuMsPer1000: number;
  /** The intercept: what this component set costs before any satellite exists. */
  baseCpuMs: number;
  /** 1.0 means the cost is linear in the count; well under it means it is not. */
  r2: number;
  /** Where the mean frame time crosses 16.7 ms, extrapolated from the fit. */
  satsAt60fps: number | "";
}

function leastSquares(points: readonly { x: number; y: number }[]): { slope: number; intercept: number; r2: number } | undefined {
  if (points.length < 2) {
    return undefined;
  }
  const n = points.length;
  const meanX = points.reduce((total, point) => total + point.x, 0) / n;
  const meanY = points.reduce((total, point) => total + point.y, 0) / n;
  const sxx = points.reduce((total, point) => total + (point.x - meanX) ** 2, 0);
  const sxy = points.reduce((total, point) => total + (point.x - meanX) * (point.y - meanY), 0);
  if (sxx === 0) {
    return undefined;
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const ssTot = points.reduce((total, point) => total + (point.y - meanY) ** 2, 0);
  const ssRes = points.reduce((total, point) => total + (point.y - (slope * point.x + intercept)) ** 2, 0);
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

const FRAME_BUDGET_60FPS_MS = 1000 / 60;

/**
 * One row per series: how its cost grows with the satellite count. Keyed by
 * component set *and* clock rate, so a sweep over both does not average a fit
 * across clocks and report a slope belonging to neither.
 */
export function scalingFits(run: BenchmarkRun): ScalingFit[] {
  const bySeries = new Map<string, BenchmarkResult[]>();
  for (const result of measured(run)) {
    const key = seriesOf(result);
    bySeries.set(key, [...(bySeries.get(key) ?? []), result]);
  }
  const fits: ScalingFit[] = [];
  for (const [series, results] of bySeries) {
    // Against the satellites actually drawn, not the ones asked for — the two
    // part company as soon as a component does not apply to every satellite.
    const fit = leastSquares(results.map((result) => ({ x: result.applied.satellitesVisible, y: cpuMs(result) })));
    if (!fit) {
      continue;
    }
    const headroom = FRAME_BUDGET_60FPS_MS - fit.intercept;
    fits.push({
      series,
      points: results.length,
      cpuMsPer1000: round(fit.slope * 1000, 3),
      baseCpuMs: round(fit.intercept),
      r2: round(fit.r2, 3),
      satsAt60fps: fit.slope > 0 && headroom > 0 ? Math.round(headroom / fit.slope) : "",
    });
  }
  return fits;
}

export interface MarginalCost {
  sats: number;
  clock: number;
  /** The components this row adds over the set it is compared against. */
  added: string;
  over: string;
  deltaCpuMs: number;
  usPerSatellite: number;
}

/**
 * What each component costs, by differencing rows measured under identical
 * conditions — same satellite count *and* same clock rate. Differencing across
 * clocks would attribute propagation to whichever component happened to be
 * added, which is the one thing this table must not do.
 *
 * Every set is compared against the largest set in the bucket that is a strict
 * subset of it. That makes the cumulative sweep report the cost of each
 * component on top of the ones before it, and the isolated sweep report each
 * component's cost over a bare point — from one function, so neither sweep
 * needs its own reader.
 */
export function marginalCosts(run: BenchmarkRun): MarginalCost[] {
  const byCondition = new Map<string, BenchmarkResult[]>();
  for (const result of measured(run)) {
    const key = `${result.applied.satellitesRequested}@${result.applied.clockMultiplier}`;
    byCondition.set(key, [...(byCondition.get(key) ?? []), result]);
  }
  const costs: MarginalCost[] = [];
  const buckets = [...byCondition.values()];
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  buckets.sort((a, b) => (a[0]?.applied.satellitesRequested ?? 0) - (b[0]?.applied.satellitesRequested ?? 0));
  for (const results of buckets) {
    for (const result of results) {
      const own = new Set(result.applied.componentsRequested);
      let baseline: BenchmarkResult | undefined;
      for (const candidate of results) {
        const other = candidate.applied.componentsRequested;
        if (other.length >= own.size || !other.every((component) => own.has(component))) {
          continue;
        }
        if (baseline === undefined || other.length > baseline.applied.componentsRequested.length) {
          baseline = candidate;
        }
      }
      if (!baseline) {
        continue;
      }
      const base = new Set(baseline.applied.componentsRequested);
      const delta = cpuMs(result) - cpuMs(baseline);
      const drawn = result.applied.satellitesVisible;
      costs.push({
        sats: result.applied.satellitesRequested,
        clock: result.applied.clockMultiplier,
        added: formatComponents(result.applied.componentsRequested.filter((component) => !base.has(component))),
        over: formatComponents(baseline.applied.componentsRequested),
        deltaCpuMs: round(delta),
        usPerSatellite: drawn > 0 ? round((delta * 1000) / drawn, 1) : 0,
      });
    }
  }
  return costs;
}

export interface PropagationCost {
  sats: number;
  components: string;
  clock: number;
  cpuMs: number;
  /** Cost over the same scene at real time. */
  deltaCpuMs: number;
  /** That delta shared out per satellite, which is what should scale with the count. */
  usPerSatellite: number;
}

/**
 * What running the clock faster costs, by differencing each clock rate against
 * ×1 for the same satellites and the same components.
 *
 * This is the propagation axis: drawing does not care what the clock is doing,
 * but `SampledTrajectory` refreshes its window on a simulation-time schedule, so
 * a faster clock re-propagates the same satellites more often per wall second.
 * A `usPerSatellite` that holds steady across counts at one clock rate says the
 * cost is per-satellite propagation and nothing else.
 */
export function propagationCosts(run: BenchmarkRun): PropagationCost[] {
  const byScene = new Map<string, BenchmarkResult[]>();
  for (const result of measured(run)) {
    const key = `${result.applied.satellitesRequested}|${formatComponents(result.applied.componentsRequested)}`;
    byScene.set(key, [...(byScene.get(key) ?? []), result]);
  }
  const costs: PropagationCost[] = [];
  for (const results of byScene.values()) {
    const baseline = results.find((result) => result.applied.clockMultiplier === 1);
    // Without a ×1 row there is nothing to difference against, and a table of
    // absolute figures under four different clocks answers no question.
    if (!baseline || results.length < 2) {
      continue;
    }
    for (const result of results) {
      if (result === baseline) {
        continue;
      }
      const delta = cpuMs(result) - cpuMs(baseline);
      const drawn = result.applied.satellitesVisible;
      costs.push({
        sats: result.applied.satellitesRequested,
        components: formatComponents(result.applied.componentsRequested),
        clock: result.applied.clockMultiplier,
        cpuMs: round(cpuMs(result)),
        deltaCpuMs: round(delta),
        usPerSatellite: drawn > 0 ? round((delta * 1000) / drawn, 1) : 0,
      });
    }
  }
  // eslint-disable-next-line unicorn/no-array-sort -- built locally
  return costs.sort((a, b) => a.sats - b.sats || a.clock - b.clock);
}

export interface RepeatCheck {
  sats: number;
  components: string;
  clock: number;
  firstCpuMs: number;
  repeatCpuMs: number;
  /** Positive means the app got slower over the course of the run. */
  cpuDriftPct: number;
  firstBuildMs: number;
  repeatBuildMs: number;
  /** Usually strongly negative: the first build pays for warming the app up. */
  buildDriftPct: number;
}

/** Above this the run measured a moving target, not a scene. */
export const MAX_TRUSTWORTHY_DRIFT_PCT = 10;

const driftPct = (first: number, repeat: number): number => (first === 0 ? 0 : round(((repeat - first) / first) * 100, 1));

/**
 * The first step against its re-run at the end of the sweep.
 *
 * A sweep is minutes long and the app it measures does not hold still: shader
 * caches fill, the JIT settles, the heap grows. Measuring one scene at the start
 * and again at the finish is the only thing in the run that can tell a rising
 * line that is the scene from a rising line that is the clock — so a small
 * `cpuDriftPct` is what licenses reading the rest of the tables at all.
 *
 * `buildDriftPct` is usually the louder of the two and is expected to be
 * negative: the first build of a population pays for warming it up, which is why
 * `buildMs` is not comparable across component sets.
 */
export function repeatChecks(run: BenchmarkRun): RepeatCheck[] {
  const checks: RepeatCheck[] = [];
  for (const repeat of run.results.filter((result) => result.step.repeat)) {
    const first = measured(run).find(
      (candidate) =>
        candidate.applied.satellitesRequested === repeat.applied.satellitesRequested &&
        candidate.applied.clockMultiplier === repeat.applied.clockMultiplier &&
        formatComponents(candidate.applied.componentsRequested) === formatComponents(repeat.applied.componentsRequested),
    );
    if (!first) {
      continue;
    }
    checks.push({
      sats: repeat.applied.satellitesRequested,
      components: formatComponents(repeat.applied.componentsRequested),
      clock: repeat.applied.clockMultiplier,
      firstCpuMs: round(cpuMs(first)),
      repeatCpuMs: round(cpuMs(repeat)),
      cpuDriftPct: driftPct(cpuMs(first), cpuMs(repeat)),
      firstBuildMs: round(first.applied.buildMs),
      repeatBuildMs: round(repeat.applied.buildMs),
      buildDriftPct: driftPct(first.applied.buildMs, repeat.applied.buildMs),
    });
  }
  return checks;
}

const pad = (value: string | number, width: number): string => String(value).padStart(width);

/** A fixed-width table, for pasting into an issue. */
export function formatTable(run: BenchmarkRun): string {
  const rows = reportRows(run);
  const header = ["sats", "visible", "clock", "frames", "fps", "frameMs", "p95", "worst", "cpuMs", "cpuP95", "gpuMs", "jank%", "build", "heapMb", "components"];
  const widths = [6, 8, 7, 7, 7, 8, 7, 8, 7, 7, 7, 6, 8, 8];
  const lines = [header.map((name, index) => (index < widths.length ? pad(name, widths[index] as number) : ` ${name}`)).join("")];
  for (const row of rows) {
    const values = [
      row.sats,
      row.visible,
      `x${row.clock}`,
      row.frames,
      row.fps,
      row.frameMs,
      row.p95Ms,
      row.worstMs,
      row.cpuMs,
      row.cpuP95Ms,
      row.gpuMs === "" ? "—" : row.gpuMs,
      row.jankPct,
      row.buildMs,
      row.heapMb,
    ];
    const suffix = `${row.repeat ? " (repeat)" : ""}${row.drawn ? ` (drew ${row.drawn})` : ""}`;
    lines.push(`${values.map((value, index) => pad(value, widths[index] as number)).join("")} ${row.components}${suffix}`);
  }
  return lines.join("\n");
}

export function toCsv(run: BenchmarkRun): string {
  const rows = reportRows(run);
  const first = rows[0];
  if (!first) {
    return "";
  }
  const keys = Object.keys(first) as (keyof ReportRow)[];
  const escape = (value: string | number | boolean): string =>
    typeof value === "string" && (value.includes(",") || value.includes('"')) ? `"${value.replaceAll('"', '""')}"` : String(value);
  return [keys.join(","), ...rows.map((row) => keys.map((key) => escape(row[key])).join(","))].join("\n");
}

export function toJson(run: BenchmarkRun): string {
  return JSON.stringify(
    {
      startedAtIso: run.startedAtIso,
      environment: run.environment,
      options: run.options,
      catalogSize: run.catalogSize,
      cancelled: run.cancelled,
      rows: reportRows(run),
      scaling: scalingFits(run),
      marginal: marginalCosts(run),
      propagation: propagationCosts(run),
      repeat: repeatChecks(run),
      componentInstances: run.results.map((result) => ({
        sats: result.applied.satellitesRequested,
        components: formatComponents(result.applied.componentsRequested),
        clock: result.applied.clockMultiplier,
        instances: result.applied.componentInstances,
      })),
    },
    null,
    2,
  );
}

/** Below this a row is an average of too little to mean anything. */
export const MIN_TRUSTWORTHY_FRAMES = 20;

/** Rows whose sample was too thin to be worth reading. */
export const thinRows = (run: BenchmarkRun): ReportRow[] => reportRows(run).filter((row) => row.frames < MIN_TRUSTWORTHY_FRAMES);

/** The console half of the framework: the tables, and the environment behind them. */
export function logRun(run: BenchmarkRun): void {
  const title = `satvis benchmark — ${run.results.length} steps${run.cancelled ? " (cancelled)" : ""}`;
  console.group(title);
  console.log("environment", run.environment);
  console.log("options", run.options, `catalog: ${run.catalogSize}`);
  const thin = thinRows(run);
  if (thin.length > 0) {
    // Said before the tables rather than after: a run taken in a background tab
    // presents almost no frames, and every timing below it is noise.
    console.warn(
      `${thin.length}/${run.results.length} steps sampled fewer than ${MIN_TRUSTWORTHY_FRAMES} frames — treat their timings as noise.`,
      run.environment.visibility === "hidden" ? "The tab was hidden; a hidden tab suspends the render loop entirely." : "",
    );
  }
  // Said once, before the table, so a blank gpu column is a known absence rather
  // than a mystery. The distinction matters: "no extension" is a browser fact,
  // "not believable" is a finding about this machine's driver.
  const anyGpu = run.results.some((result) => result.frames.gpu !== undefined);
  if (!anyGpu) {
    console.log("gpuMs: unavailable — this browser offers no EXT_disjoint_timer_query_webgl2.");
  } else if (!gpuTimerTrustworthy(run)) {
    console.warn(
      `gpuMs: withheld — the driver's timer reported more than ${GPU_TIMER_TRUST_FACTOR}× the frame interval on most steps, ` +
        "which a frame that presented cannot have cost. Known to happen on ANGLE/Metal. Read frameMs against cpuMs instead: " +
        "the gap between them is the GPU, and if frameMs is well above the display's fastest interval the scene is GPU-bound.",
    );
  }
  console.log("%cper step", "font-weight:bold");
  console.table(reportRows(run));
  console.log("%cscaling with satellite count (cpu frame time)", "font-weight:bold");
  console.table(scalingFits(run));
  console.log("%cmarginal cost per component", "font-weight:bold");
  console.table(marginalCosts(run));
  // Only when the clock was actually swept — an empty table would read as
  // "propagation costs nothing" rather than "nobody asked".
  const propagation = propagationCosts(run);
  if (propagation.length > 0) {
    console.log("%ccost of running the clock faster (propagation)", "font-weight:bold");
    console.table(propagation);
  }
  const repeats = repeatChecks(run);
  if (repeats.length > 0) {
    console.log("%cfirst step re-run at the end (drift)", "font-weight:bold");
    console.table(repeats);
    // Said out loud rather than left to be spotted in a column: this is the one
    // number that says whether the rest of the run measured a scene or a
    // moving target.
    const drifted = repeats.filter((check) => Math.abs(check.cpuDriftPct) > MAX_TRUSTWORTHY_DRIFT_PCT);
    if (drifted.length > 0) {
      console.warn(
        `The first step measured ${drifted.map((check) => `${check.cpuDriftPct > 0 ? "+" : ""}${check.cpuDriftPct}%`).join(", ")} differently when re-run at the end — ` +
          `over ${MAX_TRUSTWORTHY_DRIFT_PCT}%, so the app moved under the sweep and the trends above are that as much as the scenes.`,
      );
    }
  }
  console.groupEnd();
}

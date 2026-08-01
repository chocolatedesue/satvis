// PROTOTYPE — see ./README.md.
//
// Turning a run into the four answers it was collected for: the raw rows, how
// the frame time scales with the satellite count, what each component costs on
// top of what was already being drawn, and what running the clock faster costs.
// Pure — a run in, strings and numbers out — so the console output and the
// panel's table cannot disagree.

import { formatComponents, formatSeries } from "./benchmarkPlan";
import type { BenchmarkResult, BenchmarkRun } from "./benchmarkRunner";

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

/** The frame time a row is judged by: the work done, not the vsync wait. */
const cpuMs = (result: BenchmarkResult): number => result.frames.cpu?.mean ?? 0;

/** What varies within a series: the component set and the clock rate together. */
const seriesOf = (result: BenchmarkResult): string => formatSeries(result.applied.componentsRequested, result.applied.clockMultiplier);

export interface ReportRow {
  sats: number;
  components: string;
  /** The clock rate, as a multiple of real time. */
  clock: number;
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
  jankPct: number;
  buildMs: number;
  clearMs: number;
  entities: number;
  primitives: number;
  heapMb: number | "";
}

export function reportRows(run: BenchmarkRun): ReportRow[] {
  return run.results.map((result) => {
    const requested = formatComponents(result.applied.componentsRequested);
    const drawn = formatComponents(result.applied.componentsDrawn);
    return {
      sats: result.applied.satellitesRequested,
      components: requested,
      clock: result.applied.clockMultiplier,
      drawn: drawn === requested ? "" : drawn,
      visible: result.applied.satellitesVisible,
      frames: result.frames.frames,
      fps: round(result.frames.fps, 1),
      frameMs: round(result.frames.wall?.mean ?? 0),
      p95Ms: round(result.frames.wall?.p95 ?? 0),
      worstMs: round(result.frames.wall?.max ?? 0),
      cpuMs: round(cpuMs(result)),
      cpuP95Ms: round(result.frames.cpu?.p95 ?? 0),
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
  for (const result of run.results) {
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
  for (const result of run.results) {
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
  for (const result of run.results) {
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

const pad = (value: string | number, width: number): string => String(value).padStart(width);

/** A fixed-width table, for pasting into an issue. */
export function formatTable(run: BenchmarkRun): string {
  const rows = reportRows(run);
  const header = ["sats", "visible", "clock", "frames", "fps", "frameMs", "p95", "worst", "cpuMs", "cpuP95", "jank%", "build", "heapMb", "components"];
  const widths = [6, 8, 7, 7, 7, 8, 7, 8, 7, 7, 6, 8, 8];
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
      row.jankPct,
      row.buildMs,
      row.heapMb,
    ];
    lines.push(`${values.map((value, index) => pad(value, widths[index] as number)).join("")} ${row.components}${row.drawn ? ` (drew ${row.drawn})` : ""}`);
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
  const escape = (value: string | number): string =>
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
  console.groupEnd();
}

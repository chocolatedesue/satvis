// PROTOTYPE — see ./README.md.
//
// Turning a run into the three answers it was collected for: the raw rows, how
// the frame time scales with the satellite count, and what each component costs
// on top of what was already being drawn. Pure — a run in, strings and numbers
// out — so the console output and the panel's table cannot disagree.

import { formatComponents } from "./benchmarkPlan";
import type { BenchmarkResult, BenchmarkRun } from "./benchmarkRunner";

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

/** The frame time a row is judged by: the work done, not the vsync wait. */
const cpuMs = (result: BenchmarkResult): number => result.frames.cpu?.mean ?? 0;

export interface ReportRow {
  sats: number;
  components: string;
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
  components: string;
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

/** One row per component set: how its cost grows with the satellite count. */
export function scalingFits(run: BenchmarkRun): ScalingFit[] {
  const bySet = new Map<string, BenchmarkResult[]>();
  for (const result of run.results) {
    const key = formatComponents(result.applied.componentsRequested);
    bySet.set(key, [...(bySet.get(key) ?? []), result]);
  }
  const fits: ScalingFit[] = [];
  for (const [components, results] of bySet) {
    // Against the satellites actually drawn, not the ones asked for — the two
    // part company as soon as a component does not apply to every satellite.
    const fit = leastSquares(results.map((result) => ({ x: result.applied.satellitesVisible, y: cpuMs(result) })));
    if (!fit) {
      continue;
    }
    const headroom = FRAME_BUDGET_60FPS_MS - fit.intercept;
    fits.push({
      components,
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
  /** The components this row adds over the set it is compared against. */
  added: string;
  over: string;
  deltaCpuMs: number;
  usPerSatellite: number;
}

/**
 * What each component costs, by differencing rows at the same satellite count.
 *
 * Every set is compared against the largest set in the run that is a strict
 * subset of it. That makes the cumulative sweep report the cost of each
 * component on top of the ones before it, and the isolated sweep report each
 * component's cost over a bare point — from one function, so neither sweep
 * needs its own reader.
 */
export function marginalCosts(run: BenchmarkRun): MarginalCost[] {
  const byCount = new Map<number, BenchmarkResult[]>();
  for (const result of run.results) {
    const count = result.applied.satellitesRequested;
    byCount.set(count, [...(byCount.get(count) ?? []), result]);
  }
  const costs: MarginalCost[] = [];
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  for (const [sats, results] of [...byCount].sort((a, b) => a[0] - b[0])) {
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
        sats,
        added: formatComponents(result.applied.componentsRequested.filter((component) => !base.has(component))),
        over: formatComponents(baseline.applied.componentsRequested),
        deltaCpuMs: round(delta),
        usPerSatellite: drawn > 0 ? round((delta * 1000) / drawn, 1) : 0,
      });
    }
  }
  return costs;
}

const pad = (value: string | number, width: number): string => String(value).padStart(width);

/** A fixed-width table, for pasting into an issue. */
export function formatTable(run: BenchmarkRun): string {
  const rows = reportRows(run);
  const header = ["sats", "visible", "frames", "fps", "frameMs", "p95", "worst", "cpuMs", "cpuP95", "jank%", "build", "heapMb", "components"];
  const widths = [6, 8, 7, 7, 8, 7, 8, 7, 7, 6, 8, 8];
  const lines = [header.map((name, index) => (index < widths.length ? pad(name, widths[index] as number) : ` ${name}`)).join("")];
  for (const row of rows) {
    const values = [row.sats, row.visible, row.frames, row.fps, row.frameMs, row.p95Ms, row.worstMs, row.cpuMs, row.cpuP95Ms, row.jankPct, row.buildMs, row.heapMb];
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
      componentInstances: run.results.map((result) => ({
        sats: result.applied.satellitesRequested,
        components: formatComponents(result.applied.componentsRequested),
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

/** The console half of the framework: three tables and the environment behind them. */
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
  console.groupEnd();
}

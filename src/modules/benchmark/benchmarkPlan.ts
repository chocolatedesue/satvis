// PROTOTYPE — see ./README.md.
//
// The sweep matrix. Pure: a spec in, an ordered list of steps out, so what is
// going to be measured can be read (and argued with) before anything renders.

import { SATELLITE_COMPONENTS } from "../../config/components";

export interface BenchmarkStep {
  index: number;
  satelliteCount: number;
  components: string[];
  /** The clock rate the step runs at. See DEFAULT_CLOCK_MULTIPLIERS. */
  clockMultiplier: number;
  /**
   * What the step varies within — its component set and clock rate. This is the
   * key the report groups by, so the fit for one series is never contaminated by
   * rows measured under a different clock.
   */
  series: string;
  label: string;
}

export interface PlanSpec {
  satelliteCounts: readonly number[];
  componentSets: readonly (readonly string[])[];
  /** Omitted means real time only — a one-value axis, and no wasted steps. */
  clockMultipliers?: readonly number[];
}

/**
 * Roughly log-spaced, and 0 is a step rather than an omission: it is the only
 * row that says what the globe costs on its own, which every other row is
 * measured against.
 */
export const DEFAULT_SATELLITE_COUNTS: readonly number[] = [0, 10, 50, 100, 250, 500, 1000, 2500, 5000];

/**
 * Clock rates for the propagation axis.
 *
 * Propagation is not paid per frame, it is paid per *simulated* quarter orbit:
 * `SampledTrajectory.start` refreshes its window on a simulation-time callback,
 * and each refresh re-propagates 120 SGP4 samples per orbit for that satellite.
 * So the number of refreshes per wall second is proportional to the multiplier —
 * at ×1000 a quarter orbit goes by in about a second and a half, where at ×1 it
 * takes a quarter of an orbit. Sweeping the multiplier at a fixed satellite
 * count is therefore how the cost of propagation is separated from the cost of
 * drawing, which does not care what the clock is doing.
 */
export const DEFAULT_CLOCK_MULTIPLIERS: readonly number[] = [1, 10, 100, 1000];

/**
 * Each set adds one component to the set before it, so the difference between
 * two consecutive rows is the cost of the component that was added — on top of
 * everything already being drawn.
 */
export const CUMULATIVE_COMPONENT_SETS: readonly (readonly string[])[] = ((): string[][] => {
  const sets: string[][] = [[]];
  for (const component of SATELLITE_COMPONENTS) {
    sets.push([...(sets[sets.length - 1] as string[]), component]);
  }
  return sets;
})();

/**
 * Every set is Point plus exactly one other component, so no component's cost
 * is hiding behind another's. Point is the baseline rather than nothing at all
 * because a satellite with no point still has to exist, and this way the delta
 * is the drawing rather than the satellite.
 */
export const ISOLATED_COMPONENT_SETS: readonly (readonly string[])[] = [
  ["Point"],
  ...SATELLITE_COMPONENTS.filter((component) => component !== "Point").map((component) => ["Point", component]),
];

export const formatComponents = (components: readonly string[]): string => (components.length === 0 ? "(none)" : components.join(" + "));

/** `×1` is left off: it is the default, and saying it would be noise on every row. */
export const formatSeries = (components: readonly string[], clockMultiplier: number): string =>
  clockMultiplier === 1 ? formatComponents(components) : `${formatComponents(components)} @ ×${clockMultiplier}`;

/**
 * Component sets outermost, then clock rates, then counts ascending, so a sweep
 * cancelled half way through has finished whole series rather than leaving every
 * one of them with a hole in it.
 */
export function buildPlan(spec: PlanSpec): BenchmarkStep[] {
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  const counts = [...new Set(spec.satelliteCounts)].filter((count) => Number.isInteger(count) && count >= 0).sort((a, b) => a - b);
  const multipliers = [...new Set(spec.clockMultipliers ?? [1])].filter((value) => Number.isFinite(value) && value > 0);
  const steps: BenchmarkStep[] = [];
  for (const components of spec.componentSets) {
    for (const clockMultiplier of multipliers) {
      for (const satelliteCount of counts) {
        steps.push({
          index: steps.length,
          satelliteCount,
          components: [...components],
          clockMultiplier,
          series: formatSeries(components, clockMultiplier),
          label: `${satelliteCount} sats · ${formatSeries(components, clockMultiplier)}`,
        });
      }
    }
  }
  return steps;
}

/** What to tell the user before they start something that takes minutes. */
export function estimateDurationMs(steps: readonly BenchmarkStep[], perStepMs: number): number {
  // A step costs its warmup and sample period plus the build, which is the part
  // that grows with the count and is not worth modelling here beyond a nudge.
  return steps.length * (perStepMs + 400);
}

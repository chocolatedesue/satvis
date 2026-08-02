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
   * True for the closing re-run of the first step. Excluded from every derived
   * table — it is a second sample of a scene already measured, and its job is to
   * be compared against the original rather than averaged into it.
   */
  repeat: boolean;
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
  /** Close by re-running the first step. Defaults to true; see appendRepeat. */
  repeatFirstStep?: boolean;
}

/**
 * Roughly log-spaced, and 0 is a step rather than an omission: it is the only
 * row that says what the globe costs on its own, which every other row is
 * measured against.
 *
 * Five, not the nine this used to be. Each count costs the better part of ten
 * seconds, and the ones that were dropped sat between neighbours close enough
 * that the fit barely moved — a sweep short enough to actually be run beats a
 * denser one nobody waits out. Widen it by hand when a particular stretch of the
 * curve is the question.
 */
export const DEFAULT_SATELLITE_COUNTS: readonly number[] = [0, 100, 500, 1000, 5000];

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
 *
 * The first step is then re-run as the last one. A sweep is minutes long and the
 * app it measures gets warmer as it goes — shader caches fill, the JIT settles,
 * the heap grows — so the only way to know whether a rising line is the scene or
 * the clock is to measure one scene twice, far apart. `repeatChecks` reports the
 * difference; whether it is small is what says the rest of the run means
 * anything.
 */
export function buildPlan(spec: PlanSpec): BenchmarkStep[] {
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  const counts = [...new Set(spec.satelliteCounts)].filter((count) => Number.isInteger(count) && count >= 0).sort((a, b) => a - b);
  const multipliers = [...new Set(spec.clockMultipliers ?? [1])].filter((value) => Number.isFinite(value) && value > 0);
  const steps: BenchmarkStep[] = [];
  const push = (satelliteCount: number, components: readonly string[], clockMultiplier: number, repeat: boolean): void => {
    const series = formatSeries(components, clockMultiplier);
    steps.push({
      index: steps.length,
      satelliteCount,
      components: [...components],
      clockMultiplier,
      repeat,
      series,
      label: `${satelliteCount} sats · ${series}${repeat ? " (repeat)" : ""}`,
    });
  };

  for (const components of spec.componentSets) {
    for (const clockMultiplier of multipliers) {
      for (const satelliteCount of counts) {
        push(satelliteCount, components, clockMultiplier, false);
      }
    }
  }

  const first = steps[0];
  // Nothing to compare a lone step against, and repeating it would only double
  // the wait for the same one answer.
  if (first && steps.length > 1 && (spec.repeatFirstStep ?? true)) {
    push(first.satelliteCount, first.components, first.clockMultiplier, true);
  }
  return steps;
}

/**
 * What to tell the user before they start something that takes minutes.
 *
 * `footprintMs` is not a rounding term: a footprint capture waits about 17 s for a
 * collection, so on the default sweep it is the difference between four minutes
 * and fourteen. Showing that before the run is what lets someone choose three
 * counts instead of five rather than discovering the cost half way through.
 */
export function estimateDurationMs(steps: readonly BenchmarkStep[], perStepMs: number, footprintMs = 0): number {
  // A step costs its warmup and sample period plus the build, which is the part
  // that grows with the count and is not worth modelling here beyond a nudge.
  return steps.length * (perStepMs + 400 + footprintMs);
}

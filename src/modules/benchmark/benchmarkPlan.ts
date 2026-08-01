// PROTOTYPE — see ./README.md.
//
// The sweep matrix. Pure: a spec in, an ordered list of steps out, so what is
// going to be measured can be read (and argued with) before anything renders.

import { SATELLITE_COMPONENTS } from "../../config/components";

export interface BenchmarkStep {
  index: number;
  satelliteCount: number;
  components: string[];
  label: string;
}

export interface PlanSpec {
  satelliteCounts: readonly number[];
  componentSets: readonly (readonly string[])[];
}

/**
 * Roughly log-spaced, and 0 is a step rather than an omission: it is the only
 * row that says what the globe costs on its own, which every other row is
 * measured against.
 */
export const DEFAULT_SATELLITE_COUNTS: readonly number[] = [0, 10, 50, 100, 250, 500, 1000, 2500, 5000];

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

/**
 * Component sets outermost and counts ascending within each, so a sweep that is
 * cancelled half way through has finished whole component sets rather than
 * leaving every one of them with a hole in it.
 */
export function buildPlan(spec: PlanSpec): BenchmarkStep[] {
  // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
  const counts = [...new Set(spec.satelliteCounts)].filter((count) => Number.isInteger(count) && count >= 0).sort((a, b) => a - b);
  const steps: BenchmarkStep[] = [];
  for (const components of spec.componentSets) {
    for (const satelliteCount of counts) {
      steps.push({
        index: steps.length,
        satelliteCount,
        components: [...components],
        label: `${satelliteCount} sats · ${formatComponents(components)}`,
      });
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

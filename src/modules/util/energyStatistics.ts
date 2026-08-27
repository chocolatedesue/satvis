// Energy statistics over the illumination model: the numbers a power-aware scheduler
// needs, computed from the same ν and κ the globe is painted with.
//
// Cesium-free, so vitest exercises it directly and a report generator can call it.
//
// Nothing here is a new physical model. ν comes from satellite.js's `shadowFraction`
// — the exact circle–circle overlap of the Sun's and Earth's apparent discs, with
// Vallado's low-precision sun — and κ is the panel model documented in
// ./illumination.ts. This file only counts and aggregates what those two say, which
// is the point: a statistic that disagrees with the picture would be worse than no
// statistic.
//
// What it deliberately does not do: model batteries, charge rates, panel area,
// pointing losses, thermal limits or duty-cycle policy. It reports the *illumination*
// facts a power budget is built on — durations and fractions — and stops there.

import type { SatRec } from "satellite.js";

import type { IlluminationState, PanelAxis } from "../../config/illumination";
import { illuminationAt, illuminationTimeline } from "./illumination";

/** Whether this state leaves the satellite with no usable power under the panel model. */
export function isDark(state: IlluminationState): boolean {
  return state === "umbra" || state === "penumbra" || state === "sunlit_back";
}

/** Whether the Earth is between the satellite and the sun, panel aside. */
export function isEclipsed(state: IlluminationState): boolean {
  return state === "umbra" || state === "penumbra";
}

export interface RunLengths {
  /** Longest unbroken run, in seconds. 0 when the predicate never holds. */
  longestSeconds: number;
  /** Total time the predicate holds, in seconds. */
  totalSeconds: number;
  /** How many separate runs there were. */
  count: number;
}

/**
 * The longest and total time a predicate holds over a state timeline.
 *
 * Runs are measured in sample steps, so a run of `n` consecutive samples is
 * `n × step` seconds — which overstates a run by up to one step at each end. At the
 * 10 s step these statistics are computed with, that is the same order as the
 * penumbra itself, so a penumbra "duration" from this is a bound rather than a
 * measurement. Eclipse and dark runs are hundreds of times longer and unaffected.
 *
 * Deliberately not wrapped: the caller samples whole orbits, and a run that spans the
 * seam is two runs here. That undercounts the longest run only when the seam falls
 * inside an eclipse, which is why the callers below sample two orbits and report the
 * longest run found in the middle of the window rather than at its edge.
 */
export function runLengths(states: readonly IlluminationState[], holds: (state: IlluminationState) => boolean, stepSeconds: number): RunLengths {
  let longest = 0;
  let total = 0;
  let count = 0;
  let current = 0;
  for (const state of states) {
    if (holds(state)) {
      current += 1;
      total += 1;
      if (current === 1) {
        count += 1;
      }
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return { longestSeconds: longest * stepSeconds, totalSeconds: total * stepSeconds, count };
}

export interface OrbitEnergyProfile {
  periodMinutes: number;
  /** Sun elevation above the orbit plane at the start of the window, in degrees. */
  betaDeg: number;
  /** Share of the window spent with the Earth between the satellite and the sun. */
  eclipseFraction: number;
  /** Share with no usable power at all: eclipse, or a panel facing away. */
  darkFraction: number;
  /** Longest unbroken eclipse, in seconds — what a battery has to carry. */
  longestEclipseSeconds: number;
  /** Longest unbroken run with no usable power — what a task has to survive or migrate before. */
  longestDarkSeconds: number;
  /** Time per orbit spent in penumbra, summed over both crossings. A bound; see runLengths. */
  penumbraSecondsPerOrbit: number;
  /** How many eclipse entries the window contained, for reading the above as per-orbit. */
  eclipseCount: number;
}

/**
 * One satellite's energy profile over a window, in the state vocabulary the globe uses.
 *
 * Two orbits by default, not one: a single-orbit window puts its seam somewhere, and
 * if that somewhere is inside an eclipse the longest run comes out halved. Two orbits
 * guarantee at least one eclipse lies wholly inside the window, and the per-orbit
 * figures are then the window's divided by the orbits sampled.
 */
export function orbitEnergyProfile(satrec: SatRec, start: Date, axis: PanelAxis, stepSeconds = 10, orbits = 2): OrbitEnergyProfile {
  const periodMinutes = (2 * Math.PI) / satrec.no;
  const windowSeconds = periodMinutes * 60 * orbits;
  const timeline = illuminationTimeline(satrec, start, windowSeconds, stepSeconds, axis);
  const states = timeline.samples.map((sample) => sample.state);
  const eclipse = runLengths(states, isEclipsed, stepSeconds);
  const dark = runLengths(states, isDark, stepSeconds);
  const penumbra = runLengths(states, (state) => state === "penumbra", stepSeconds);
  return {
    periodMinutes,
    betaDeg: illuminationAt(satrec, start, axis)?.betaDeg ?? Number.NaN,
    eclipseFraction: (timeline.fractions.umbra ?? 0) + (timeline.fractions.penumbra ?? 0),
    darkFraction: timeline.darkFraction,
    longestEclipseSeconds: eclipse.longestSeconds,
    longestDarkSeconds: dark.longestSeconds,
    penumbraSecondsPerOrbit: penumbra.totalSeconds / orbits,
    eclipseCount: eclipse.count,
  };
}

export interface FleetSnapshot {
  total: number;
  counts: Partial<Record<IlluminationState, number>>;
  /** Share of the fleet with the Earth between it and the sun, right now. */
  eclipsedFraction: number;
  /** Share of the fleet with no usable power, right now. */
  darkFraction: number;
}

/**
 * What the whole fleet looks like at one instant.
 *
 * The routing-level question the per-satellite profile cannot answer: not "how often
 * is a satellite in shadow" but "how much of the fleet is in shadow *at the same
 * time*", which is what decides whether work can be moved rather than merely delayed.
 */
export function fleetSnapshot(satrecs: readonly SatRec[], date: Date, axis: PanelAxis): FleetSnapshot {
  const counts: Partial<Record<IlluminationState, number>> = {};
  let total = 0;
  let eclipsed = 0;
  let dark = 0;
  for (const satrec of satrecs) {
    const illumination = illuminationAt(satrec, date, axis);
    if (!illumination) {
      continue;
    }
    total += 1;
    counts[illumination.state] = (counts[illumination.state] ?? 0) + 1;
    if (isEclipsed(illumination.state)) {
      eclipsed += 1;
    }
    if (isDark(illumination.state)) {
      dark += 1;
    }
  }
  return { total, counts, eclipsedFraction: total === 0 ? 0 : eclipsed / total, darkFraction: total === 0 ? 0 : dark / total };
}

export interface Spread {
  min: number;
  mean: number;
  max: number;
}

function spreadOf(values: readonly number[]): Spread {
  if (values.length === 0) {
    return { min: Number.NaN, mean: Number.NaN, max: Number.NaN };
  }
  return {
    min: Math.min(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
  };
}

export interface FleetSeries {
  samples: number;
  eclipsedFraction: Spread;
  darkFraction: Spread;
}

/**
 * The same, walked over a window — so the answer is a range rather than one instant.
 *
 * The spread is the interesting part. A fleet whose eclipsed share barely moves is one
 * whose capacity loss is a constant to be provisioned for; one that swings is a
 * scheduling problem.
 */
export function fleetSeries(satrecs: readonly SatRec[], start: Date, durationSeconds: number, stepSeconds: number, axis: PanelAxis): FleetSeries {
  const eclipsed: number[] = [];
  const dark: number[] = [];
  for (let offset = 0; offset <= durationSeconds; offset += stepSeconds) {
    const snapshot = fleetSnapshot(satrecs, new Date(start.getTime() + offset * 1000), axis);
    eclipsed.push(snapshot.eclipsedFraction);
    dark.push(snapshot.darkFraction);
  }
  return { samples: eclipsed.length, eclipsedFraction: spreadOf(eclipsed), darkFraction: spreadOf(dark) };
}

/**
 * How long from `from` until this satellite next loses usable power, in seconds.
 *
 * The scheduling horizon: how long a task started now can run before its host goes
 * dark. `undefined` when the satellite is already dark — the caller has to distinguish
 * "plenty of time" from "no time at all", and a 0 would read as the latter for both.
 * Also `undefined` when nothing happens inside the horizon, which for the always-sunlit
 * orbits of the previous round is the honest answer.
 */
export function secondsUntilDark(satrec: SatRec, from: Date, axis: PanelAxis, horizonSeconds: number, stepSeconds = 10): number | undefined {
  const now = illuminationAt(satrec, from, axis);
  if (!now || isDark(now.state)) {
    return undefined;
  }
  for (let offset = stepSeconds; offset <= horizonSeconds; offset += stepSeconds) {
    const state = illuminationAt(satrec, new Date(from.getTime() + offset * 1000), axis)?.state;
    if (state && isDark(state)) {
      return offset;
    }
  }
  return undefined;
}

/** A percentile of a sample set, by nearest rank. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index] as number;
}

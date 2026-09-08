// How much compute a cluster can be expected to deliver, and how steady that
// expectation is.
//
// The geometry modules answer "does the configuration come back". The energy
// modules answer "how much of an orbit is there power". Neither answers the
// question a compute service is actually asked, which is a conjunction of the
// two: **a pipeline only produces tokens while every one of its stages has
// power at the same time.** One stage in shadow is the whole pipeline stopped,
// so the fleet's average illumination — the number every power budget is quoted
// in — is not the number the service lives on.
//
// What this file adds is the selection: given a pool of satellites and a budget
// of stages, **which** satellites should host them. The objective is not the
// sunniest satellites but the set whose joint power is most predictable, which
// is a different thing: two satellites in the same plane go dark together, and
// two in planes a quarter turn apart do not.
//
// Two numbers on purpose, because one of them is the answer and the other is the
// excuse:
//
//   - **serving fraction** — the share of the cycle in which every host has power,
//     with the stages staying where they were placed. This is what a design
//     delivers.
//   - **ceiling** — the share in which _some_ set of that many satellites has
//     power. This is what migration could reach, and the gap between the two is
//     exactly what a hand-off mechanism is being bought for (`./migration.ts`).
//
// Secular J₂, cylindrical shadow, no attitude: an upper bound on power, and the
// same simplification `docs/orbital-compute.md` states for its energy layer.

import { jday, sunPos } from "satellite.js";

import type { OrbitPhase } from "./clusterRange.ts";
import { WGS72_EARTH_RADIUS_KM, circularPositionKm } from "./orbitModel.ts";

/** The sun's unit vector in the equatorial frame, from satellite.js's own low-precision model. */
function sunDirectionKm(date: Date): [number, number, number] {
  const { rtasc, decl } = sunPos(jday(date));
  return [Math.cos(decl) * Math.cos(rtasc), Math.cos(decl) * Math.sin(rtasc), Math.sin(decl)];
}

export interface PowerSeries {
  /** One row per sample: which members have power at that instant. */
  powered: boolean[][];
  /** Seconds between samples. */
  stepSeconds: number;
  /** Hours covered. */
  hours: number;
  /** Share of samples each member has power, aligned with the members. */
  litFraction: number[];
}

export interface PowerOptions {
  /** When the cycle starts. */
  start: Date;
  /** How long to sample, in hours. */
  hours: number;
  /** Sample step in seconds. Default 60 — a tenth of the shortest eclipse worth planning around. */
  stepSeconds?: number;
  /**
   * Whether the sun moves during the window. Default true.
   *
   * Held still only for the model ablation: a 24-hour window is a degree of the
   * sun's own motion, and freezing it is the error that makes a one-cycle sample
   * look like a year. Kept as an option so the size of that error is a number in
   * the paper instead of an assumption in it.
   */
  moveSun?: boolean;
}

/**
 * Whether a satellite has power: outside the Earth's shadow, cylindrical model.
 *
 * The cylindrical shadow is the honest choice at this altitude — the umbra is
 * 99.9% of an eclipse's duration and the penumbra is seconds — and it is the same
 * test `./migration.ts` runs for line of sight, so the two agree about where the
 * Earth is. No panel angle: a satellite is assumed to keep its panels usable,
 * which makes every number here an upper bound.
 */
function poweredAt(position: [number, number, number], sun: [number, number, number]): boolean {
  const alongSun = position[0] * sun[0] + position[1] * sun[1] + position[2] * sun[2];
  if (alongSun >= 0) {
    return true;
  }
  const across = Math.hypot(position[0] - alongSun * sun[0], position[1] - alongSun * sun[1], position[2] - alongSun * sun[2]);
  return across >= WGS72_EARTH_RADIUS_KM;
}

/**
 * Which members have power, sampled across the window.
 *
 * The sun is moved as well as the satellites: a 24-hour cycle is a degree of the
 * sun's own motion, and holding it still would put the terminator in the same
 * place for the whole run — which is exactly the error that makes a two-orbit
 * sample look like a year.
 */
export function powerSeries(members: readonly OrbitPhase[], options: PowerOptions): PowerSeries {
  const stepSeconds = options.stepSeconds ?? 60;
  const moveSun = options.moveSun ?? true;
  const samples = Math.max(1, Math.round((options.hours * 3600) / stepSeconds));
  const powered: boolean[][] = [];
  const lit = members.map(() => 0);
  for (let index = 0; index <= samples; index += 1) {
    const hours = (index / samples) * options.hours;
    const date = moveSun ? new Date(options.start.getTime() + index * stepSeconds * 1000) : options.start;
    const sun = sunDirectionKm(date);
    const row = members.map((member, at) => {
      const on = poweredAt(circularPositionKm(member, member.nodeDeg, member.phaseDeg, hours), sun);
      if (on) {
        lit[at] = (lit[at] as number) + 1;
      }
      return on;
    });
    powered.push(row);
  }
  return { powered, stepSeconds, hours: options.hours, litFraction: lit.map((count) => (samples + 1 > 0 ? count / (samples + 1) : 0)) };
}

/** Share of samples in which every one of these members has power. */
export function jointLitFraction(series: PowerSeries, members: readonly number[]): number {
  if (members.length === 0 || series.powered.length === 0) {
    return 0;
  }
  let together = 0;
  for (const row of series.powered) {
    if (members.every((at) => row[at] === true)) {
      together += 1;
    }
  }
  return together / series.powered.length;
}

/**
 * Pick the `count` members whose joint power is steadiest.
 *
 * Greedy, and honestly so: the objective — the share of the cycle in which every
 * chosen member has power — is monotone _decreasing_ in the set, so this is not a
 * submodular maximisation and the 1 − 1/e guarantee does not apply. What greedy
 * does guarantee is the thing a reader wants checked: every pick is the best
 * available at the time, and the running score is reported, so a bad pick is
 * visible as a flat step rather than hidden inside an optimum nobody can inspect.
 * The pool is tens of satellites, and the exact answer is a choose-k enumeration
 * that nobody can read either.
 *
 * The first pick is the sunniest member; every later one is the member whose
 * outages overlap the current set's least. Two satellites in one plane go dark
 * together and are never both chosen, which is the whole content of the result.
 */
export function selectHosts(series: PowerSeries, count: number, candidates?: readonly number[]): number[] {
  const pool = candidates ?? series.litFraction.map((_, index) => index);
  if (count <= 0 || pool.length === 0) {
    return [];
  }
  const chosen: number[] = [];
  let best = pool[0] as number;
  for (const candidate of pool) {
    if ((series.litFraction[candidate] as number) > (series.litFraction[best] as number)) {
      best = candidate;
    }
  }
  chosen.push(best);
  while (chosen.length < Math.min(count, pool.length)) {
    let pick: number | undefined;
    let pickScore = -1;
    for (const candidate of pool) {
      if (chosen.includes(candidate)) {
        continue;
      }
      const score = jointLitFraction(series, [...chosen, candidate]);
      // Ties go to the sunnier member, so the sequence is deterministic and the
      // report reads the same way twice.
      const tie = score === pickScore ? (series.litFraction[candidate] as number) > (series.litFraction[pick as number] as number) : false;
      if (score > pickScore || tie) {
        pick = candidate;
        pickScore = score;
      }
    }
    if (pick === undefined) {
      break;
    }
    chosen.push(pick);
  }
  return chosen;
}

/**
 * The baseline the whole selection rests on: pick the sunniest satellites.
 *
 * Wrong on purpose, and worth measuring because it is what a power budget
 * suggests — maximise each host's own illumination. It ignores correlation, and
 * correlation is the entire phenomenon: two satellites in one plane are both
 * bright and both dark at the same instant.
 */
export function selectHostsSunniest(series: PowerSeries, count: number): number[] {
  return series.litFraction
    .map((fraction, index) => ({ fraction, index }))
    .toSorted((a, b) => b.fraction - a.fraction || a.index - b.index)
    .slice(0, Math.max(0, count))
    .map((entry) => entry.index);
}

/**
 * A random placement, and the floor any selection has to beat.
 *
 * Deterministic: a linear congruential generator with a stated seed, so a table
 * in the paper is the table anyone reruns. Averaged over seeds by the caller.
 */
export function selectHostsRandom(series: PowerSeries, count: number, seed = 1): number[] {
  const pool = series.litFraction.map((_, index) => index);
  let state = (seed * 1103515245 + 12345) >>> 0;
  const next = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 0x100000000;
  };
  for (let at = pool.length - 1; at > 0; at -= 1) {
    const swap = Math.floor(next() * (at + 1));
    const held = pool[at] as number;
    pool[at] = pool[swap] as number;
    pool[swap] = held;
  }
  return pool.slice(0, Math.max(0, count));
}

/**
 * What the whole fleet's GPU budget is actually producing.
 *
 * The headline number for a fixed budget: delivered GPU-hours over every GPU
 * every satellite carries, lit or not. A design can score a perfect serving
 * fraction and still waste its budget, if the pipeline is cut too shallow to
 * use the fleet it is flying on.
 */
export function fleetUtilization(report: CapacityReport, satellites: number, gpusPerSat = 1, hours = 1): number {
  const budget = satellites * gpusPerSat * hours;
  return budget > 0 ? report.gpuHours / budget : 0;
}

export interface CapacityReport {
  /** The members chosen to host the stages, in the order they were picked. */
  hosts: number[];
  /** GPUs that can be working while every host has power. */
  workingGpus: number;
  /** Share of the cycle in which every host has power — the design's own expectation. */
  servingFraction: number;
  /** Share in which _some_ set of that many members has power — what migration could reach. */
  ceilingFraction: number;
  /** GPU-hours delivered over the window, counted only while the pipeline is whole. */
  gpuHours: number;
  /** The longest unbroken serving run, in seconds: the window a job can rely on. */
  longestServingSeconds: number;
  /** The longest stall, in seconds: the outage a scheduler has to absorb. */
  longestStallSeconds: number;
  /** How many separate stalls the window contains. */
  stalls: number;
}

/** Runs of a boolean series, in samples: longest, total, count. */
function runs(values: readonly boolean[]): { longest: number; total: number; count: number } {
  let longest = 0;
  let total = 0;
  let count = 0;
  let current = 0;
  for (const value of values) {
    if (value) {
      current += 1;
      total += 1;
    } else {
      longest = Math.max(longest, current);
      if (current > 0) {
        count += 1;
      }
      current = 0;
    }
  }
  longest = Math.max(longest, current);
  if (current > 0) {
    count += 1;
  }
  return { longest, total, count };
}

/**
 * What a placement delivers over the window.
 *
 * `servingFraction` is the number to design against and `longestStallSeconds` is
 * the number to schedule against: a fleet that is lit 93% of the time in
 * thirty-second pieces and one that is lit 93% in a single twenty-minute eclipse
 * are not the same service, and only the second pair of columns tells them apart.
 */
export function capacityReport(series: PowerSeries, hosts: readonly number[], gpusPerHost = 1): CapacityReport {
  const serving = series.powered.map((row) => hosts.length > 0 && hosts.every((at) => row[at] === true));
  const needed = hosts.length;
  const ceiling = series.powered.map((row) => (needed === 0 ? true : row.filter((on) => on).length >= needed));
  const on = runs(serving);
  const off = runs(serving.map((value) => !value));
  const servingFraction = serving.length > 0 ? on.total / serving.length : 0;
  const workingGpus = hosts.length * gpusPerHost;
  return {
    hosts: [...hosts],
    workingGpus,
    servingFraction,
    ceilingFraction: ceiling.length > 0 ? ceiling.filter((value) => value).length / ceiling.length : 0,
    gpuHours: servingFraction * workingGpus * series.hours,
    longestServingSeconds: on.longest * series.stepSeconds,
    longestStallSeconds: off.longest * series.stepSeconds,
    stalls: off.count,
  };
}

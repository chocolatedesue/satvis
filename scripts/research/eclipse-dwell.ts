// Eclipse dwell depth: the longest-sunlit neighbour is the real hand-off target.
//
//   node --experimental-strip-types scripts/research/eclipse-dwell.ts
//   node --experimental-strip-types scripts/research/eclipse-dwell.ts run [hours] [stepSeconds]
//   node --experimental-strip-types scripts/research/eclipse-dwell.ts selfcheck
//
// The previous round (scripts/research/eclipse-neighbor.ts) measured the nearest
// sunlit satellite at ingress and found its median remaining sunlight was only
// 60-270 s: the nearest lit neighbour is usually in the same patch of sky and
// enters shadow right behind you. The one-hop reachable fraction was 100% and told
// nobody anything. What a pre-hand-off actually needs is the sunlit satellite with
// the LONGEST remaining dwell -- ideally one in a plane whose beta keeps it out of
// shadow entirely -- and that target can be much farther away.
//
// This script quantifies the distance-versus-dwell trade. For every ingress event it
// records the nearest sunlit satellite (the previous metric, kept as the control),
// the longest-sunlit satellite (infinity allowed, and infinity wins), and the nearest
// sunlit satellite whose remaining dwell clears 2 / 10 / 60 minutes. It also looks at
// the structure of dwell itself: per-plane eclipse-free fractions, and how the
// remaining dwell of the k-th nearest sunlit satellite falls with distance -- the
// mechanism being that neighbours share geometry and enter shadow together, so a long
// dwell has to be found in another plane.
//
// Pipeline. Each configuration is propagated ONCE: a 48 h / 30 s sunlit/eclipsed
// timeline for every satellite, from which a next-dark index array is derived so any
// ingress event can read any satellite's remaining dwell in O(1). The event pass then
// re-propagates only the steps that actually contain an ingress, so the whole
// constellation is never re-flown per event.
//
// Everything is the app's own physics: walkerDeltaRecords, satellite.js SGP4,
// illuminationOf + isEclipsed (umbra or penumbra), maxLinkRangeKm for the one-hop
// horizon, differentialDrag for the migration variants. See
// docs/eclipse-neighbor-analysis.md for the readings.

import { writeFileSync } from "node:fs";

import { propagate, type SatRec } from "satellite.js";

import { isEclipsed } from "../../src/modules/util/energyStatistics.ts";
import { createSatrec, recordName, type GpRecord } from "../../src/modules/util/gp.ts";
import { illuminationOf, illuminationTimeline, sunGeometry } from "../../src/modules/util/illumination.ts";
import { maxLinkRangeKm } from "../../src/modules/util/shellLayout.ts";
import { satsPerPlane, walkerDeltaRecords, WALKER_EPOCH_ISO } from "../../src/modules/util/walkerDelta.ts";
import { SCENARIOS, migrationScenarios, type Scenario } from "./eclipse-neighbor.ts";

/** Two extra contrasts that isolate plane count and RAAN span at fixed T/h/i. */
const EXTRA_SCENARIOS: Scenario[] = [
  {
    id: "p10",
    label: "53 250/10/1 @550",
    params: { total: 250, planes: 10, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "same T/h/i/F, a third of the planes",
  },
  {
    id: "star180",
    label: "53 250/25/1 @550~180",
    params: { total: 250, planes: 25, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 180 },
    note: "same T/P/F/h, planes over 180 deg (Walker Star)",
  },
];

/** The sweep: the eight requested configurations plus the two contrasts. */
const SWEEP: Scenario[] = [...SCENARIOS, ...EXTRA_SCENARIOS];

const EPOCH = new Date(WALKER_EPOCH_ISO);
const DEFAULT_HOURS = 48;
const DEFAULT_STEP_SECONDS = 30;
const AXIS = "zenith" as const;

/** How far past the window a target is followed before its remaining dwell is called infinite. */
const LOOKAHEAD_SECONDS = 24 * 3600;

/** Remaining-dwell thresholds for the nearest usable satellite, seconds. */
const THRESHOLDS = [120, 600, 3600] as const;

/** How many of the nearest sunlit satellites per event feed the distance-vs-dwell curve. */
const NEAREST_K = 5;

/** Distance bucket edges for that curve, km. */
const DISTANCE_BUCKETS = [0, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 1e9] as const;

function wrap360(value: number): number {
  return ((value % 360) + 360) % 360;
}

interface Summary {
  count: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  max: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function summarize(values: readonly number[]): Summary | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))] as number;
  return {
    count: values.length,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    median: median(sorted),
    p10: at(0.1),
    p90: at(0.9),
    max: sorted[sorted.length - 1] as number,
  };
}

interface NearPair {
  d: number;
  r: number;
}

interface DwellEvent {
  satName: string;
  timeMs: number;
  nearestName: string;
  nearestDist: number;
  nearestRemaining: number;
  longestName: string;
  longestDist: number;
  longestRemaining: number;
  nearestWithinHorizon: boolean;
  finiteLongestDist: number | undefined;
  finiteLongestRemaining: number | undefined;
  d2Dist: number | undefined;
  d10Dist: number | undefined;
  d60Dist: number | undefined;
  near: NearPair[];
}

interface PlaneStat {
  plane: number;
  sats: number;
  eclipseFreeSats: number;
  meanSunlitRunSeconds: number;
  meanEclipseFraction: number;
}

interface DwellResult {
  scenario: Scenario;
  satellites: number;
  horizonKm: number;
  samples: number;
  stepSeconds: number;
  planeCount: number;
  eclipseFraction: number;
  events: DwellEvent[];
  planeStats: PlaneStat[];
}

/**
 * One configuration: one propagation pass for the sunlit timeline and the next-dark
 * indices, then a second pass that re-propagates only ingress steps.
 */
function runDwell(scenario: Scenario, hours: number, stepSeconds: number): DwellResult {
  const { params } = scenario;
  const records: GpRecord[] = walkerDeltaRecords(params, EPOCH);
  const total = records.length;
  const names = records.map((record) => recordName(record));
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as GpRecord;
    const offset = scenario.phaseOffset?.(index, total, params) ?? 0;
    if (offset !== 0 && record.kind === "omm") {
      record.omm.MEAN_ANOMALY = wrap360(Number(record.omm.MEAN_ANOMALY) + offset);
    }
  }
  const satrecs: SatRec[] = records.map((record) => createSatrec(record));
  const horizonKm = maxLinkRangeKm(params.altitudeKm, params.altitudeKm);
  const steps = Math.max(1, Math.round((hours * 3600) / stepSeconds));
  const samples = steps + 1;

  // --- pass 1: one SGP4 propagation per satellite per step, eclipse timeline only.
  const eclipsed = new Uint8Array(samples * total);
  let eclipsedTotal = 0;
  for (let step = 0; step < samples; step += 1) {
    const date = new Date(EPOCH.getTime() + step * stepSeconds * 1000);
    const sun = sunGeometry(date);
    if (!sun) {
      break;
    }
    const base = step * total;
    for (let index = 0; index < total; index += 1) {
      const state = propagate(satrecs[index] as SatRec, date);
      if (!state || typeof state.position === "boolean" || typeof state.velocity === "boolean") {
        eclipsed[base + index] = 1;
        eclipsedTotal += 1;
        continue;
      }
      const illumination = illuminationOf(state.position, state.velocity, sun, AXIS);
      const inShadow = illumination ? isEclipsed(illumination.state) : true;
      eclipsed[base + index] = inShadow ? 1 : 0;
      if (inShadow) {
        eclipsedTotal += 1;
      }
    }
  }

  // --- next-dark index: nextDark[step*N + i] is the first eclipse-start step at or
  // after step, or -1. Derived by one backward scan; no propagation, O(1) queries.
  const nextDark = new Int32Array(samples * total).fill(-1);
  for (let step = samples - 1; step >= 0; step -= 1) {
    const base = step * total;
    const nextBase = base + total;
    for (let index = 0; index < total; index += 1) {
      const here = eclipsed[base + index] === 1;
      const previous = step === 0 ? 0 : eclipsed[base - total + index] === 1;
      if (here && !previous) {
        nextDark[base + index] = step;
      } else if (step + 1 < samples) {
        nextDark[base + index] = nextDark[nextBase + index] as number;
      }
    }
  }

  // For a target with no in-window ingress left, its next ingress is the same for
  // every event on its remaining sunlit run: the first one after the window ends.
  // Computed lazily, once per satellite, so the beyond-window 24 h lookahead the
  // spec asks for costs at most one scan per satellite rather than one per event.
  const afterWindow = new Map<number, number | undefined>();
  const remainingAfterWindow = (index: number): number | undefined => {
    if (afterWindow.has(index)) {
      return afterWindow.get(index);
    }
    const fromWindowEnd = new Date(EPOCH.getTime() + steps * stepSeconds * 1000);
    const value = secondsUntilIngress(satrecs[index] as SatRec, fromWindowEnd.getTime(), stepSeconds, LOOKAHEAD_SECONDS);
    afterWindow.set(index, value);
    return value;
  };

  // --- pass 2: only the steps with an ingress get re-propagated.
  const events: DwellEvent[] = [];
  for (let step = 1; step < samples; step += 1) {
    const base = step * total;
    const previousBase = base - total;
    let hasIngress = false;
    for (let index = 0; index < total; index += 1) {
      if (eclipsed[base + index] === 1 && eclipsed[previousBase + index] === 0) {
        hasIngress = true;
        break;
      }
    }
    if (!hasIngress) {
      continue;
    }
    const date = new Date(EPOCH.getTime() + step * stepSeconds * 1000);
    const positions = new Float64Array(total * 3);
    for (let index = 0; index < total; index += 1) {
      const state = propagate(satrecs[index] as SatRec, date);
      if (state && typeof state.position !== "boolean" && typeof state.velocity !== "boolean") {
        positions[index * 3] = state.position.x;
        positions[index * 3 + 1] = state.position.y;
        positions[index * 3 + 2] = state.position.z;
      }
    }
    for (let sat = 0; sat < total; sat += 1) {
      if (eclipsed[base + sat] !== 1 || eclipsed[previousBase + sat] !== 0) {
        continue;
      }
      const ax = positions[sat * 3] as number;
      const ay = positions[sat * 3 + 1] as number;
      const az = positions[sat * 3 + 2] as number;
      let nearestDist = Infinity;
      let nearestName = "";
      let nearestRemaining = 0;
      let longestDist = Infinity;
      let longestName = "";
      let longestRemaining = -1;
      let finiteLongestDist = Infinity;
      let finiteLongestRemaining = -1;
      let d2Dist = Infinity;
      let d10Dist = Infinity;
      let d60Dist = Infinity;
      const near: NearPair[] = [];
      for (let other = 0; other < total; other += 1) {
        if (other === sat || eclipsed[base + other] === 1) {
          continue;
        }
        const ox = positions[other * 3] as number;
        const oy = positions[other * 3 + 1] as number;
        const oz = positions[other * 3 + 2] as number;
        const distance = Math.hypot(ax - ox, ay - oy, az - oz);
        const start = nextDark[base + other] as number;
        let remaining: number;
        if (start >= 0) {
          remaining = (start - step) * stepSeconds;
        } else {
          const after = remainingAfterWindow(other);
          remaining = after === undefined ? Number.POSITIVE_INFINITY : (steps - step) * stepSeconds + after;
        }
        if (distance < nearestDist) {
          nearestDist = distance;
          nearestName = names[other] as string;
          nearestRemaining = remaining;
        }
        // Longest dwell wins; a tie goes to the nearer satellite.
        if (remaining > longestRemaining || (remaining === longestRemaining && distance < longestDist)) {
          longestRemaining = remaining;
          longestDist = distance;
          longestName = names[other] as string;
        }
        // Best among finite-dwell targets: the fallback when no never-dark star is reachable.
        if (Number.isFinite(remaining) && remaining > finiteLongestRemaining) {
          finiteLongestRemaining = remaining;
          finiteLongestDist = distance;
        }
        if (distance <= horizonKm) {
          if (remaining >= THRESHOLDS[0] && distance < d2Dist) {
            d2Dist = distance;
          }
          if (remaining >= THRESHOLDS[1] && distance < d10Dist) {
            d10Dist = distance;
          }
          if (remaining >= THRESHOLDS[2] && distance < d60Dist) {
            d60Dist = distance;
          }
        }
        if (near.length < NEAREST_K) {
          near.push({ d: distance, r: remaining });
          near.sort((a, b) => a.d - b.d);
        } else if (distance < (near[NEAREST_K - 1] as NearPair).d) {
          near[NEAREST_K - 1] = { d: distance, r: remaining };
          near.sort((a, b) => a.d - b.d);
        }
      }
      events.push({
        satName: names[sat] as string,
        timeMs: date.getTime(),
        nearestName,
        nearestDist,
        nearestRemaining,
        longestName,
        longestDist,
        longestRemaining,
        nearestWithinHorizon: nearestDist <= horizonKm,
        finiteLongestDist: finiteLongestDist === Infinity ? undefined : finiteLongestDist,
        finiteLongestRemaining: finiteLongestRemaining < 0 ? undefined : finiteLongestRemaining,
        d2Dist: d2Dist === Infinity ? undefined : d2Dist,
        d10Dist: d10Dist === Infinity ? undefined : d10Dist,
        d60Dist: d60Dist === Infinity ? undefined : d60Dist,
        near,
      });
    }
  }

  // --- per-plane structure: which planes never enter shadow at all.
  const perPlane = satsPerPlane(params);
  const planeStats: PlaneStat[] = [];
  for (let plane = 0; plane < params.planes; plane += 1) {
    let eclipseFreeSats = 0;
    let runTotal = 0;
    let runCount = 0;
    let eclipseSum = 0;
    let sats = 0;
    for (let slot = 0; slot < perPlane; slot += 1) {
      const index = plane * perPlane + slot;
      if (index >= total) {
        break;
      }
      sats += 1;
      let eclipsedSteps = 0;
      let currentRun = 0;
      let anyEclipse = false;
      for (let step = 0; step < samples; step += 1) {
        if (eclipsed[step * total + index] === 1) {
          eclipsedSteps += 1;
          anyEclipse = true;
          if (currentRun > 0) {
            runTotal += currentRun;
            runCount += 1;
            currentRun = 0;
          }
        } else {
          currentRun += 1;
        }
      }
      if (currentRun > 0) {
        runTotal += currentRun;
        runCount += 1;
      }
      if (!anyEclipse) {
        eclipseFreeSats += 1;
      }
      eclipseSum += eclipsedSteps / samples;
    }
    planeStats.push({
      plane,
      sats,
      eclipseFreeSats,
      meanSunlitRunSeconds: runCount > 0 ? (runTotal / runCount) * stepSeconds : Number.NaN,
      meanEclipseFraction: sats > 0 ? eclipseSum / sats : Number.NaN,
    });
  }

  return {
    scenario,
    satellites: total,
    horizonKm,
    samples,
    stepSeconds,
    planeCount: params.planes,
    eclipseFraction: total * samples > 0 ? eclipsedTotal / (total * samples) : 0,
    events,
    planeStats,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Aggregate {
  result: DwellResult;
  nearestDist: Summary | undefined;
  nearestRemaining: Summary | undefined;
  longestDist: Summary | undefined;
  longestRemaining: Summary | undefined;
  extraDistance: Summary | undefined;
  d2Dist: Summary | undefined;
  d10Dist: Summary | undefined;
  d60Dist: Summary | undefined;
  d2Miss: number;
  d10Miss: number;
  d60Miss: number;
  longestInfiniteShare: number;
  longestWithinHorizonShare: number;
  finiteLongestDist: Summary | undefined;
  finiteLongestRemaining: Summary | undefined;
}

function aggregate(result: DwellResult): Aggregate {
  const events = result.events;
  const finite = (values: readonly number[]) => values.filter((value) => Number.isFinite(value));
  const nearestDist = summarize(events.map((event) => event.nearestDist));
  const nearestRemaining = summarize(finite(events.map((event) => event.nearestRemaining)));
  const longestDist = summarize(events.map((event) => event.longestDist));
  const longestRemaining = summarize(finite(events.map((event) => event.longestRemaining)));
  const extraDistance = summarize(events.map((event) => event.longestDist - event.nearestDist));
  const d2 = events.map((event) => event.d2Dist).filter((value): value is number => value !== undefined);
  const d10 = events.map((event) => event.d10Dist).filter((value): value is number => value !== undefined);
  const d60 = events.map((event) => event.d60Dist).filter((value): value is number => value !== undefined);
  const count = events.length;
  const infinite = events.filter((event) => event.longestRemaining === Number.POSITIVE_INFINITY).length;
  const within = events.filter((event) => event.longestDist <= result.horizonKm).length;
  return {
    result,
    nearestDist,
    nearestRemaining,
    longestDist,
    longestRemaining,
    extraDistance,
    d2Dist: summarize(d2),
    d10Dist: summarize(d10),
    d60Dist: summarize(d60),
    d2Miss: count === 0 ? 0 : (count - d2.length) / count,
    d10Miss: count === 0 ? 0 : (count - d10.length) / count,
    d60Miss: count === 0 ? 0 : (count - d60.length) / count,
    longestInfiniteShare: count === 0 ? 0 : infinite / count,
    longestWithinHorizonShare: count === 0 ? 0 : within / count,
    finiteLongestDist: summarize(events.flatMap((event) => (event.finiteLongestDist === undefined ? [] : [event.finiteLongestDist]))),
    finiteLongestRemaining: summarize(events.flatMap((event) => (event.finiteLongestRemaining === undefined ? [] : [event.finiteLongestRemaining]))),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function fixed(value: number | undefined, digits: number): string {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function pct(value: number): string {
  return (value * 100).toFixed(1);
}

function printAggregate(title: string, rows: readonly Aggregate[]): void {
  console.log("\n== " + title + " ==");
  console.log(
    pad("scenario", 16) +
      pad("events", 8) +
      pad("nearDist", 10) +
      pad("nearRem", 9) +
      pad("longDist mean", 14) +
      pad("med", 9) +
      pad("p90", 9) +
      pad("longRem med", 12) +
      pad("inf%", 7) +
      pad("extra", 9) +
      pad("d10 med", 9) +
      pad("miss10%", 9) +
      pad("finD med", 9) +
      pad("finDist med", 12) +
      pad("long<ISL%", 10),
  );
  for (const row of rows) {
    console.log(
      pad(row.result.scenario.id, 16) +
        pad(row.result.events.length, 8) +
        pad(fixed(row.nearestDist?.mean, 0), 10) +
        pad(fixed(row.nearestRemaining?.median, 0), 9) +
        pad(fixed(row.longestDist?.mean, 0), 14) +
        pad(fixed(row.longestDist?.median, 0), 9) +
        pad(fixed(row.longestDist?.p90, 0), 9) +
        pad(fixed(row.longestRemaining?.median, 0), 12) +
        pad(pct(row.longestInfiniteShare), 7) +
        pad(fixed(row.extraDistance?.mean, 0), 9) +
        pad(fixed(row.d10Dist?.median, 0), 9) +
        pad(pct(row.d10Miss), 9) +
        pad(fixed(row.finiteLongestRemaining?.median, 0), 9) +
        pad(fixed(row.finiteLongestDist?.median, 0), 12) +
        pad(pct(row.longestWithinHorizonShare), 10),
    );
  }
  console.log(
    "(distances km, dwell s; longRem med is finite-only and usually empty because inf% is high; finD/finDist = best target that does ingress inside the lookahead; extra = longest - nearest mean km; d10 = nearest within ISL with dwell >= 600 s; inf% = longest target is eclipse-free over the lookahead; long<ISL% = that target is inside the ISL chord)",
  );
}

function printThresholds(rows: readonly Aggregate[]): void {
  console.log("\n== nearest usable satellite by dwell threshold (within ISL horizon) ==");
  console.log(pad("scenario", 16) + pad("d2 med", 9) + pad("miss2%", 8) + pad("d10 med", 9) + pad("miss10%", 9) + pad("d60 med", 9) + pad("miss60%", 9));
  for (const row of rows) {
    console.log(
      pad(row.result.scenario.id, 16) +
        pad(fixed(row.d2Dist?.median, 0), 9) +
        pad(pct(row.d2Miss), 8) +
        pad(fixed(row.d10Dist?.median, 0), 9) +
        pad(pct(row.d10Miss), 9) +
        pad(fixed(row.d60Dist?.median, 0), 9) +
        pad(pct(row.d60Miss), 9),
    );
  }
  console.log("(distances km; miss = no sunlit satellite inside the ISL chord with that much dwell left; thresholds are 120 / 600 / 3600 s)");
}

function printPlaneStats(result: DwellResult, maxRows: number): void {
  console.log("\n== per-plane dwell structure: " + result.scenario.id + " (" + result.planeCount + " planes) ==");
  console.log(pad("plane", 7) + pad("sats", 6) + pad("eclipse-free", 14) + pad("mean sunlit run s", 18) + pad("eclipse%", 9));
  const shown = result.planeStats.slice(0, maxRows);
  for (const stat of shown) {
    console.log(
      pad(stat.plane + 1, 7) +
        pad(stat.sats, 6) +
        pad(stat.eclipseFreeSats + "/" + stat.sats, 14) +
        pad(fixed(stat.meanSunlitRunSeconds, 0), 18) +
        pad(pct(stat.meanEclipseFraction), 9),
    );
  }
  if (result.planeStats.length > shown.length) {
    const rest = result.planeStats.slice(shown.length);
    const free = rest.reduce((total, stat) => total + stat.eclipseFreeSats, 0);
    const sats = rest.reduce((total, stat) => total + stat.sats, 0);
    console.log(pad("...", 7) + pad(sats, 6) + pad(free + "/" + sats, 14));
  }
}

function printCorrelation(title: string, results: readonly DwellResult[]): void {
  console.log("\n== remaining dwell vs distance to sunlit neighbour: " + title + " ==");
  console.log(pad("distance km", 14) + pad("pairs", 8) + pad("median dwell s", 15) + pad("inf%", 7));
  const buckets = DISTANCE_BUCKETS;
  for (let bucket = 0; bucket < buckets.length - 1; bucket += 1) {
    const low = buckets[bucket] as number;
    const high = buckets[bucket + 1] as number;
    const dwell: number[] = [];
    let total = 0;
    let infinite = 0;
    for (const result of results) {
      for (const event of result.events) {
        for (const pair of event.near) {
          if (pair.d >= low && pair.d < high) {
            total += 1;
            if (Number.isFinite(pair.r)) {
              dwell.push(pair.r);
            } else {
              infinite += 1;
            }
          }
        }
      }
    }
    const label = high >= 1e9 ? "> " + low : low + "-" + high;
    console.log(pad(label, 14) + pad(total, 8) + pad(fixed(summarize(dwell)?.median, 0), 15) + pad(total > 0 ? pct(infinite / total) : "-", 7));
  }
}

function printExtra(title: string, rows: readonly Aggregate[]): void {
  console.log("\n== " + title + " ==");
  console.log(pad("scenario", 16) + pad("near med", 10) + pad("long med", 10) + pad("extra med", 10) + pad("extra p90", 10) + pad("longer%", 9));
  for (const row of rows) {
    const longer = row.result.events.filter((event) => event.longestRemaining > event.nearestRemaining).length;
    const count = row.result.events.length;
    console.log(
      pad(row.result.scenario.id, 16) +
        pad(fixed(row.nearestDist?.median, 0), 10) +
        pad(fixed(row.longestDist?.median, 0), 10) +
        pad(fixed(row.extraDistance?.median, 0), 10) +
        pad(fixed(row.extraDistance?.p90, 0), 10) +
        pad(count > 0 ? pct(longer / count) : "-", 9),
    );
  }
  console.log("(km; longer% = share of events where the longest-dwell target outlasts the nearest one)");
}

function writeCsv(results: readonly DwellResult[]): void {
  const lines = ["scenario,satellite,ingress_utc,nearest_dist,nearest_remaining,longest_dist,longest_remaining,d10_dist,miss10"];
  for (const result of results) {
    for (const event of result.events) {
      lines.push(
        [
          result.scenario.id,
          event.satName,
          new Date(event.timeMs).toISOString(),
          event.nearestDist.toFixed(3),
          Number.isFinite(event.nearestRemaining) ? event.nearestRemaining.toFixed(0) : "inf",
          event.longestDist.toFixed(3),
          Number.isFinite(event.longestRemaining) ? event.longestRemaining.toFixed(0) : "inf",
          event.d10Dist === undefined ? "" : event.d10Dist.toFixed(3),
          event.d10Dist === undefined ? "1" : "0",
        ].join(","),
      );
    }
  }
  writeFileSync("docs/eclipse-dwell-data.csv", lines.join("\n") + "\n", "utf8");
  console.log("\nwrote docs/eclipse-dwell-data.csv (" + (lines.length - 1) + " events)");
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

function secondsUntilIngress(satrec: SatRec, fromMs: number, stepSeconds: number, maxSeconds: number): number | undefined {
  for (let offset = stepSeconds; offset <= maxSeconds; offset += stepSeconds) {
    const date = new Date(fromMs + offset * 1000);
    const sun = sunGeometry(date);
    if (!sun) {
      return undefined;
    }
    const state = propagate(satrec, date);
    if (!state || typeof state.position === "boolean" || typeof state.velocity === "boolean") {
      return undefined;
    }
    const illumination = illuminationOf(state.position, state.velocity, sun, AXIS);
    if (illumination && isEclipsed(illumination.state)) {
      return offset;
    }
  }
  return undefined;
}

function selfCheck(): void {
  const scenario: Scenario = {
    id: "selfcheck-dwell",
    label: "53 8/2/1 @550",
    params: { total: 8, planes: 2, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "2 planes x 4 satellites, 2 h",
  };
  const hours = 2;
  const stepSeconds = 30;
  const result = runDwell(scenario, hours, stepSeconds);
  console.log("self-check (dwell) -- " + scenario.label + ", " + hours + " h at " + stepSeconds + " s");
  console.log("  satellites:         " + result.satellites);
  console.log("  one-hop horizon:    " + result.horizonKm.toFixed(2) + " km");
  console.log("  eclipse fraction:   " + pct(result.eclipseFraction) + "%");
  console.log("  ingress events:     " + result.events.length);
  const first = result.events[0];
  if (!first) {
    console.log("  no ingress in the window");
    return;
  }
  console.log("  first ingress:");
  console.log("    satellite         " + first.satName + " at " + new Date(first.timeMs).toISOString());
  console.log(
    "    nearest sunlit    " +
      first.nearestName +
      "  " +
      first.nearestDist.toFixed(2) +
      " km, dwell " +
      (Number.isFinite(first.nearestRemaining) ? first.nearestRemaining.toFixed(0) + " s" : "inf"),
  );
  console.log(
    "    longest sunlit    " +
      first.longestName +
      "  " +
      first.longestDist.toFixed(2) +
      " km, dwell " +
      (Number.isFinite(first.longestRemaining) ? first.longestRemaining.toFixed(0) + " s" : "inf"),
  );
  console.log("    d10 usable        " + (first.d10Dist === undefined ? "miss" : first.d10Dist.toFixed(2) + " km"));

  // Alignment 1: timeline eclipse fraction against the repo's own illuminationTimeline.
  const records = walkerDeltaRecords(scenario.params, EPOCH);
  const byName = new Map(records.map((record) => [recordName(record), createSatrec(record)] as const));
  let repoTotal = 0;
  for (const [, satrec] of byName) {
    const timeline = illuminationTimeline(satrec, EPOCH, hours * 3600, stepSeconds, AXIS);
    repoTotal += (timeline.fractions.umbra ?? 0) + (timeline.fractions.penumbra ?? 0);
  }
  const repoFraction = repoTotal / Math.max(1, byName.size);
  console.log(
    "  alignment [timeline]: script " +
      (result.eclipseFraction * 100).toFixed(3) +
      "% vs illuminationTimeline " +
      (repoFraction * 100).toFixed(3) +
      "%  (gap " +
      Math.abs(result.eclipseFraction - repoFraction).toExponential(2) +
      ")",
  );

  // Alignment 2: the next-dark dwell for the nearest sunlit target against an
  // independent forward propagation of that same satellite.
  const nearestSatrec = byName.get(first.nearestName);
  if (nearestSatrec) {
    const forward = secondsUntilIngress(nearestSatrec, first.timeMs, stepSeconds, 6 * 3600);
    const fromTimeline = first.nearestRemaining;
    if (forward === undefined && !Number.isFinite(fromTimeline)) {
      console.log("  alignment [dwell]:   both say 'no ingress within 6 h'");
    } else {
      const gap = Math.abs((forward ?? Number.NaN) - fromTimeline);
      console.log(
        "  alignment [dwell]:   timeline " +
          (Number.isFinite(fromTimeline) ? fromTimeline.toFixed(0) + " s" : "inf") +
          " vs forward " +
          (forward === undefined ? "inf" : forward.toFixed(0) + " s") +
          "  (gap " +
          (Number.isFinite(gap) ? gap.toExponential(2) : "n/a") +
          ")",
      );
    }
  }

  // Alignment 3: a configuration where no plane can escape the shadow, so the
  // dwells are finite and the timeline's O(1) next-dark can be checked against a
  // forward propagation. 20 deg at 550 km cannot reach the beta the shadow needs
  // (max |beta| = 43.4 deg against a required 67 deg), so every plane eclipses.
  const finiteScenario: Scenario = {
    id: "selfcheck-finite",
    label: "20 8/2/1 @550",
    params: { total: 8, planes: 2, phasing: 1, inclinationDeg: 20, altitudeKm: 550, raanSpanDeg: 360 },
    note: "every plane eclipses, so dwells are finite",
  };
  const finite = runDwell(finiteScenario, hours, stepSeconds);
  const finiteFirst = finite.events[0];
  const finiteRecords = walkerDeltaRecords(finiteScenario.params, EPOCH);
  const finiteByName = new Map(finiteRecords.map((record) => [recordName(record), createSatrec(record)] as const));
  if (finiteFirst) {
    for (const which of ["nearest", "longest"] as const) {
      const name = which === "nearest" ? finiteFirst.nearestName : finiteFirst.longestName;
      const timelineRemaining = which === "nearest" ? finiteFirst.nearestRemaining : finiteFirst.longestRemaining;
      const target = finiteByName.get(name);
      const forward = target ? secondsUntilIngress(target, finiteFirst.timeMs, stepSeconds, 6 * 3600) : undefined;
      const gap = forward === undefined || !Number.isFinite(timelineRemaining) ? Number.NaN : Math.abs(forward - timelineRemaining);
      console.log(
        "  alignment [dwell finite]: " +
          finiteScenario.label +
          " " +
          which +
          "=" +
          name +
          " timeline " +
          (Number.isFinite(timelineRemaining) ? timelineRemaining.toFixed(0) + " s" : "inf") +
          " vs forward " +
          (forward === undefined ? "inf" : forward.toFixed(0) + " s") +
          (Number.isFinite(gap) ? "  (gap " + gap.toExponential(2) + ")" : ""),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(argv: string[]): void {
  const command = argv[0] ?? "run";
  if (command === "selfcheck") {
    selfCheck();
    return;
  }
  if (command !== "run") {
    console.log("usage: eclipse-dwell.ts [run [hours] [stepSeconds]] | selfcheck");
    return;
  }
  const hours = Number(argv[1] ?? DEFAULT_HOURS);
  const stepSeconds = Number(argv[2] ?? DEFAULT_STEP_SECONDS);

  const sweep = SWEEP.map((scenario) => runDwell(scenario, hours, stepSeconds));
  const sweepAgg = sweep.map(aggregate);
  printAggregate("longest-dwell target vs nearest target", sweepAgg);
  printExtra("distance cost of choosing the longest-dwell target", sweepAgg);
  printThresholds(sweepAgg);

  const baseline = SCENARIOS[0] as Scenario;
  const migration = migrationScenarios(baseline).map((scenario) => runDwell(scenario, hours, stepSeconds));
  printAggregate("migration vs static", migration.map(aggregate));

  const nearSso = sweep.find((result) => result.scenario.id === "near-sso");
  printPlaneStats(sweep[0] as DwellResult, 6);
  if (nearSso) {
    printPlaneStats(nearSso, 6);
  }
  printCorrelation("all sweep scenarios", sweep);
  if (nearSso) {
    printCorrelation("near-SSO only", [nearSso]);
  }

  writeCsv([...sweep, ...migration]);
}

main(process.argv.slice(2));

// Eclipse ingress and the nearest sunlit neighbour.
//
//   node --experimental-strip-types scripts/research/eclipse-neighbor.ts
//   node --experimental-strip-types scripts/research/eclipse-neighbor.ts run [hours] [stepSeconds]
//   node --experimental-strip-types scripts/research/eclipse-neighbor.ts selfcheck
//
// The question a total eclipse fraction cannot answer: when a satellite crosses
// into the Earth's shadow, how far away is the nearest satellite that is still in
// sunlight, and how much longer will that one stay lit? An eclipse fraction is a
// scalar; the geometry of the ingress moment is a distribution, and it is the
// distribution that decides whether a computation running on a satellite going
// dark can hand its state to a lit peer before the shadow arrives -- or whether
// there is no lit peer within an inter-satellite link at all.
//
// Everything here is the app's own physics, not a second model:
//
// - the fleet is walkerDeltaRecords, the same generator the orbit lab and the
//   globe use, propagated with the same satellite.js SGP4 the app flies;
// - "in shadow" is isEclipsed from ./energyStatistics, i.e. the umbra or
//   penumbra of satellite.js's own conical shadow (shadowFraction), fed by
//   illuminationOf exactly as the globe colours a point;
// - the one-hop test is maxLinkRangeKm(h, h), which at equal altitudes is the
//   analytical chord 2*sqrt((R+h)^2 - (R+80 km)^2) this analysis is specified
//   with -- same WGS-72 radius, same 80 km upper-atmosphere margin.
//
// Sampling. The step defaults to 30 s, which is at most a fifth of the shortest
// LEO eclipse and so places an ingress to within 30 s; the window defaults to 48 h,
// which is about thirty orbits at 550 km -- enough to sample every node phase a
// plane passes through before the ~60-day beta cycle has moved on.
//
// This is a research script, not a test: it writes docs/eclipse-neighbor-data.csv
// and prints the summary tables. See docs/eclipse-neighbor-analysis.md for the
// readings, and the appendix there for the self-check.

import { writeFileSync } from "node:fs";

import { propagate, type SatRec } from "satellite.js";

import { ballisticCoefficient, differentialDragDriftM } from "../../src/modules/util/differentialDrag.ts";
import { isEclipsed } from "../../src/modules/util/energyStatistics.ts";
import { createSatrec, recordName, type GpRecord } from "../../src/modules/util/gp.ts";
import { illuminationOf, illuminationTimeline, sunGeometry, type Vec3 } from "../../src/modules/util/illumination.ts";
import { circularSemiMajorAxisKm } from "../../src/modules/util/orbitModel.ts";
import { maxLinkRangeKm } from "../../src/modules/util/shellLayout.ts";
import { encodeWalker, satsPerPlane, walkerDeltaRecords, WALKER_EPOCH_ISO, type WalkerDeltaParams } from "../../src/modules/util/walkerDelta.ts";

/** The epoch every generated pattern is stated at, shared with the orbit lab. */
const EPOCH = new Date(WALKER_EPOCH_ISO);

const DEFAULT_HOURS = 48;
const DEFAULT_STEP_SECONDS = 30;

/**
 * How far past the window's end a nearest-lit satellite is followed to find its next
 * ingress. A day covers every LEO eclipse period with room to spare, so a satellite
 * still lit after this is treated as eclipse-free rather than merely unlucky.
 */
const LOOKAHEAD_SECONDS = 24 * 3600;

/** The panel model is irrelevant to isEclipsed, but illuminationOf wants one. */
const AXIS = "zenith" as const;

/** Distances are 3D chords in the TEME frame satellite.js reports, in kilometres. */
function chordKm(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function wrap360(value: number): number {
  return ((value % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** A mean-anomaly offset added to the generated records before they are propagated. */
type PhaseOffset = (index: number, total: number, params: WalkerDeltaParams) => number;

interface Scenario {
  id: string;
  label: string;
  params: WalkerDeltaParams;
  /** Why this scenario is in the sweep, for the report's own reading. */
  note: string;
  phaseOffset?: PhaseOffset;
}

/**
 * The sweep. The first five are the configurations the analysis was asked for; the
 * last three isolate one knob each so a difference can be attributed rather than
 * asserted: F = 0 and F = P/2 at fixed T/P/h, and a fifth of the satellites at
 * fixed planes/phasing.
 */
const SCENARIOS: Scenario[] = [
  {
    id: "walker25",
    label: "53 250/25/1 @550",
    params: { total: 250, planes: 25, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "the walker25 scene: 25 planes of 10",
  },
  {
    id: "walker25-old",
    label: "53 100/25/4 @550",
    params: { total: 100, planes: 25, phasing: 4, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "the old walker25: 25 planes of 4, different F",
  },
  {
    id: "starlink1",
    label: "53 1584/72/17 @550",
    params: { total: 1584, planes: 72, phasing: 17, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "the Starlink Gen1 shell-1 design",
  },
  {
    id: "mid-incl",
    label: "70 720/36/1 @1200",
    params: { total: 720, planes: 36, phasing: 1, inclinationDeg: 70, altitudeKm: 1200, raanSpanDeg: 360 },
    note: "a mid-inclination shell twice as high",
  },
  {
    id: "near-sso",
    label: "97.6 348/6/58 @560",
    params: { total: 348, planes: 6, phasing: 58, inclinationDeg: 97.6, altitudeKm: 560, raanSpanDeg: 360 },
    note: "near-sun-synchronous, so beta drifts the least",
  },
  {
    id: "f0",
    label: "53 250/25/0 @550",
    params: { total: 250, planes: 25, phasing: 0, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "same as walker25 but F = 0 (planes abreast)",
  },
  {
    id: "f12",
    label: "53 250/25/12 @550",
    params: { total: 250, planes: 25, phasing: 12, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "same as walker25 but F = 12, about P/2 (the ssim interleave)",
  },
  {
    id: "t50",
    label: "53 50/25/1 @550",
    params: { total: 50, planes: 25, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "same planes and F, a fifth of the satellites",
  },
];

/**
 * The migration variants, all built on the walker25 baseline.
 *
 * This is satvis's notion of migration read literally: differentialDrag says how far
 * two satellites that differ in ballistic coefficient drift apart along-track over a
 * span, and a mid-transfer fleet is one where part of it has drifted. The variant
 * adds that drift -- or, for the bracketing case, a quarter of the inter-satellite
 * spacing -- to every other satellite's mean anomaly before propagation. Nothing
 * else changes, so any difference in the ingress geometry is the phase spread and
 * not a second model.
 */
function migrationScenarios(base: Scenario): Scenario[] {
  const altitudeKm = base.params.altitudeKm;
  // The drag budget's own worst spread: B = 0.11 m^2/kg, disagreed by 100%, over
  // the window. differentialDragDriftM returns metres of along-track separation.
  const driftM = differentialDragDriftM(altitudeKm, ballisticCoefficient(0.05) * 1.0, DEFAULT_HOURS * 3600);
  const driftDeg = (driftM / (circularSemiMajorAxisKm(altitudeKm) * 1000)) * (180 / Math.PI);
  const spacingDeg = 360 / satsPerPlane(base.params);
  const onEveryOther =
    (offsetDeg: number): PhaseOffset =>
    (index) =>
      index % 2 === 0 ? offsetDeg : 0;

  return [
    {
      ...base,
      id: "mig-static",
      label: base.label + " (static)",
      note: "no migration: the uniform Walker ring",
      phaseOffset: undefined,
    },
    {
      ...base,
      id: "mig-drift",
      label: base.label + " (drag +" + driftDeg.toFixed(2) + " deg)",
      note: "differential drag, 100% ballistic spread over " + DEFAULT_HOURS + " h",
      phaseOffset: onEveryOther(driftDeg),
    },
    {
      ...base,
      id: "mig-maneuver",
      label: base.label + " (maneuver +" + (spacingDeg / 2).toFixed(1) + " deg)",
      note: "mid-maneuver: half a slot of phase on every other satellite, about a 8 km altitude difference accumulated over " + DEFAULT_HOURS + " h",
      phaseOffset: onEveryOther(spacingDeg / 2),
    },
  ];
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface IngressEvent {
  satName: string;
  step: number;
  timeMs: number;
  /** Distance to the nearest sunlit satellite at this instant, km. Undefined when none is lit. */
  distanceKm: number | undefined;
  nearestName: string | undefined;
  /** How long the nearest sunlit satellite stays lit, from this instant. Capped at the window end. */
  remainingSeconds: number | undefined;
  /** True when the nearest sunlit satellite does not itself ingress inside the window. */
  censored: boolean;
  /** Whether the distance is inside the one-hop horizon. */
  reachable: boolean;
}

interface Summary {
  count: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  max: number;
}

interface ScenarioResult {
  scenario: Scenario;
  satellites: number;
  horizonKm: number;
  windowHours: number;
  stepSeconds: number;
  /** Mean over satellites of the share of the window spent eclipsed. */
  eclipseFraction: number;
  events: IngressEvent[];
  distanceStats: Summary | undefined;
  remainingStats: Summary | undefined;
  reachableFraction: number;
  censoredCount: number;
  noNeighborCount: number;
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
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    median: median(values),
    p10: at(0.1),
    p90: at(0.9),
    max: sorted[sorted.length - 1] as number,
  };
}

/**
 * Seconds until this satellite next enters the shadow, from a known-sunlit instant.
 * Returns undefined when it stays lit for the whole lookahead. Used only for the
 * nearest-lit satellites whose next ingress falls outside the sampled window, so it
 * costs nothing on the common path.
 */
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

/**
 * One scenario over one window.
 *
 * Two passes are folded into one: each time step propagates the whole fleet once,
 * detects every satellite's sunlit <-> eclipsed transitions, and -- at an ingress --
 * scans the satellites that are lit at that same instant for the nearest one. The
 * nearest lit satellite's remaining sunlit time cannot be known until its own next
 * ingress, so it is resolved afterwards from the eclipse intervals the pass records.
 * That keeps the cost at one SGP4 propagation per satellite per step, which is the
 * whole script's budget.
 *
 * Step 0 never counts as an ingress: the window may open mid-eclipse, and there is
 * no earlier sample to have come from sunlight.
 */
function runScenario(scenario: Scenario, hours: number, stepSeconds: number): ScenarioResult {
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

  const wasEclipsed = new Uint8Array(total);
  const currentStart = new Int32Array(total).fill(-1);
  const intervals: Array<Array<[number, number]>> = Array.from({ length: total }, () => []);
  const eclipsedSteps = new Int32Array(total);
  const events: IngressEvent[] = [];

  const positions: Array<Vec3 | undefined> = Array.from({ length: total });
  const eclipsed = new Uint8Array(total);

  for (let step = 0; step < samples; step += 1) {
    const date = new Date(EPOCH.getTime() + step * stepSeconds * 1000);
    const sun = sunGeometry(date);
    if (!sun) {
      break;
    }

    const lit: number[] = [];
    for (let index = 0; index < total; index += 1) {
      const state = propagate(satrecs[index] as SatRec, date);
      if (!state || typeof state.position === "boolean" || typeof state.velocity === "boolean") {
        positions[index] = undefined;
        eclipsed[index] = 1;
        eclipsedSteps[index] += 1;
        continue;
      }
      positions[index] = state.position;
      const illumination = illuminationOf(state.position, state.velocity, sun, AXIS);
      const inShadow = illumination ? isEclipsed(illumination.state) : true;
      eclipsed[index] = inShadow ? 1 : 0;
      if (inShadow) {
        eclipsedSteps[index] += 1;
      } else {
        lit.push(index);
      }
    }

    for (let index = 0; index < total; index += 1) {
      const inShadow = eclipsed[index] === 1;
      if (inShadow && wasEclipsed[index] === 0) {
        if (step > 0) {
          const here = positions[index];
          let nearest = -1;
          let nearestKm = Infinity;
          if (here) {
            for (const other of lit) {
              const there = positions[other];
              if (!there) {
                continue;
              }
              const distance = chordKm(here, there);
              if (distance < nearestKm) {
                nearestKm = distance;
                nearest = other;
              }
            }
          }
          events.push({
            satName: names[index] as string,
            step,
            timeMs: date.getTime(),
            distanceKm: nearest >= 0 ? nearestKm : undefined,
            nearestName: nearest >= 0 ? (names[nearest] as string) : undefined,
            remainingSeconds: undefined,
            censored: false,
            reachable: nearest >= 0 && nearestKm <= horizonKm,
          });
        }
        currentStart[index] = step;
      } else if (!inShadow && wasEclipsed[index] === 1) {
        intervals[index]?.push([currentStart[index] as number, step]);
        currentStart[index] = -1;
      }
      wasEclipsed[index] = inShadow ? 1 : 0;
    }
  }

  for (let index = 0; index < total; index += 1) {
    if (currentStart[index] >= 0) {
      intervals[index]?.push([currentStart[index] as number, steps]);
    }
  }

  // Resolve each nearest-lit satellite's remaining sunlit time from its own next
  // ingress inside the window; when that falls outside, follow it forward for up to
  // LOOKAHEAD_SECONDS so the answer is a real duration rather than the window's
  // remainder. Only a satellite still lit after the whole lookahead is left flagged,
  // and then the cap is a lower bound.
  let censoredCount = 0;
  let noNeighborCount = 0;
  for (const event of events) {
    if (event.nearestName === undefined) {
      noNeighborCount += 1;
      continue;
    }
    const nearestIndex = names.indexOf(event.nearestName);
    const next = intervals[nearestIndex]?.find(([start]) => start > event.step);
    if (next) {
      event.remainingSeconds = (next[0] - event.step) * stepSeconds;
    } else {
      const lookahead = secondsUntilIngress(satrecs[nearestIndex] as SatRec, event.timeMs, stepSeconds, LOOKAHEAD_SECONDS);
      if (lookahead === undefined) {
        event.remainingSeconds = LOOKAHEAD_SECONDS;
        event.censored = true;
        censoredCount += 1;
      } else {
        event.remainingSeconds = lookahead;
      }
    }
  }

  const distances = events.flatMap((event) => (event.distanceKm === undefined ? [] : [event.distanceKm]));
  const remaining = events.flatMap((event) => (event.remainingSeconds === undefined || event.censored ? [] : [event.remainingSeconds]));
  const eclipsedTotal = eclipsedSteps.reduce((totalSteps, value) => totalSteps + value, 0);
  return {
    scenario,
    satellites: total,
    horizonKm,
    windowHours: hours,
    stepSeconds,
    eclipseFraction: eclipsedTotal / (total * samples),
    events,
    distanceStats: summarize(distances),
    remainingStats: summarize(remaining),
    reachableFraction: distances.length === 0 ? 0 : events.filter((event) => event.reachable).length / distances.length,
    censoredCount,
    noNeighborCount,
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

function printSummary(results: readonly ScenarioResult[]): void {
  console.log("\n== ingress neighbour summary ==");
  console.log(
    pad("scenario", 16) + pad("sats", 6) + pad("eclipse%", 9) + pad("events", 8) + pad("dist mean", 11) + pad("median", 9) + pad("p90", 9) + pad("max", 9) + pad("1-hop%", 8),
  );
  for (const result of results) {
    const d = result.distanceStats;
    console.log(
      pad(result.scenario.id, 16) +
        pad(result.satellites, 6) +
        pad((result.eclipseFraction * 100).toFixed(2), 9) +
        pad(result.events.length, 8) +
        pad(fixed(d?.mean, 1), 11) +
        pad(fixed(d?.median, 1), 9) +
        pad(fixed(d?.p90, 1), 9) +
        pad(fixed(d?.max, 1), 9) +
        pad((result.reachableFraction * 100).toFixed(1), 8),
    );
  }
  console.log("(distance to nearest sunlit satellite at ingress, km; baseline one-hop horizon " + (results[0]?.horizonKm.toFixed(0) ?? "?") + " km)");
}

function printRemaining(results: readonly ScenarioResult[]): void {
  console.log("\n== remaining sunlit time of that nearest neighbour ==");
  console.log(pad("scenario", 16) + pad("mean s", 10) + pad("median s", 11) + pad("p10 s", 10) + pad("censored", 10) + pad("no-lit", 8));
  for (const result of results) {
    const r = result.remainingStats;
    console.log(
      pad(result.scenario.id, 16) +
        pad(fixed(r?.mean, 0), 10) +
        pad(fixed(r?.median, 0), 11) +
        pad(fixed(r?.p10, 0), 10) +
        pad(result.censoredCount, 10) +
        pad(result.noNeighborCount, 8),
    );
  }
  console.log(
    "(censored = the nearest lit satellite was still lit after a further " +
      LOOKAHEAD_SECONDS / 3600 +
      " h lookahead; its time is the cap, a lower bound, and it is excluded from the mean/median/p10)",
  );
}

function printMigration(baseline: ScenarioResult, variants: readonly ScenarioResult[]): void {
  console.log("\n== migration vs static, on " + baseline.scenario.id + " ==");
  console.log(
    pad("variant", 16) +
      pad("eclipse%", 9) +
      pad("events", 8) +
      pad("dist mean", 11) +
      pad("median", 9) +
      pad("p90", 9) +
      pad("max", 9) +
      pad("1-hop%", 8) +
      pad("remain mean", 12) +
      pad("remain med", 11) +
      pad("cens%", 7),
  );
  for (const result of variants) {
    const d = result.distanceStats;
    const r = result.remainingStats;
    const censoredPct = result.events.length === 0 ? 0 : (result.censoredCount / result.events.length) * 100;
    console.log(
      pad(result.scenario.id, 16) +
        pad((result.eclipseFraction * 100).toFixed(2), 9) +
        pad(result.events.length, 8) +
        pad(fixed(d?.mean, 1), 11) +
        pad(fixed(d?.median, 1), 9) +
        pad(fixed(d?.p90, 1), 9) +
        pad(fixed(d?.max, 1), 9) +
        pad((result.reachableFraction * 100).toFixed(1), 8) +
        pad(fixed(r?.mean, 0), 12) +
        pad(fixed(r?.median, 0), 11) +
        pad(censoredPct.toFixed(1), 7),
    );
  }
  console.log("(the drift variant is the repo's own drag law; the maneuver variant is half a slot of phase on every other satellite)");
}

function writeCsv(results: readonly ScenarioResult[]): void {
  const lines = ["scenario,satellite,ingress_utc,distance_km,nearest_sunlit,remaining_sunlit_s,one_hop_reachable"];
  for (const result of results) {
    for (const event of result.events) {
      lines.push(
        [
          result.scenario.id,
          event.satName,
          new Date(event.timeMs).toISOString(),
          event.distanceKm === undefined ? "" : event.distanceKm.toFixed(3),
          event.nearestName ?? "",
          event.remainingSeconds === undefined ? "" : event.remainingSeconds.toFixed(0),
          event.reachable ? "1" : "0",
        ].join(","),
      );
    }
  }
  writeFileSync("docs/eclipse-neighbor-data.csv", lines.join("\n") + "\n", "utf8");
  console.log("\nwrote docs/eclipse-neighbor-data.csv (" + (lines.length - 1) + " events)");
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * A deliberately hand-checkable case: two planes of four at 53 deg / 550 km, two
 * hours. It prints the first ingress with the two positions and the chord recomputed
 * from them, and it cross-checks the scenario's eclipse fraction against a mean over
 * the app's own illuminationTimeline on the same grid, so a disagreement between this
 * script and the repo's illumination model would show up rather than be assumed away.
 */
function selfCheck(): void {
  const scenario: Scenario = {
    id: "selfcheck",
    label: "53 8/2/1 @550",
    params: { total: 8, planes: 2, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
    note: "2 planes x 4 satellites, 2 h",
  };
  const hours = 2;
  const stepSeconds = 30;
  const result = runScenario(scenario, hours, stepSeconds);
  console.log("self-check -- " + scenario.label + ", " + hours + " h at " + stepSeconds + " s");
  console.log("  generated walker:   " + encodeWalker(scenario.params));
  console.log("  satellites:         " + result.satellites);
  console.log("  one-hop horizon:    " + result.horizonKm.toFixed(2) + " km  (2*sqrt((R+h)^2-(R+80)^2))");
  console.log("  eclipse fraction:   " + (result.eclipseFraction * 100).toFixed(2) + "%");
  console.log("  ingress events:     " + result.events.length);
  const first = result.events[0];
  if (!first) {
    console.log("  no ingress in the window");
    return;
  }
  console.log("  first ingress:");
  console.log("    satellite         " + first.satName);
  console.log("    time              " + new Date(first.timeMs).toISOString());
  console.log("    nearest sunlit    " + first.nearestName + "  at " + fixed(first.distanceKm, 2) + " km");
  console.log("    remaining sunlit  " + fixed(first.remainingSeconds, 0) + " s");
  console.log("    one-hop reachable " + (first.reachable ? "yes" : "no"));

  // Recompute the reported chord from the two positions at that instant, so the
  // number in the table is not allowed to drift from the geometry it names.
  const records = walkerDeltaRecords(scenario.params, EPOCH);
  const byName = new Map(records.map((record) => [recordName(record), createSatrec(record)] as const));
  const at = new Date(first.timeMs);
  const sun = sunGeometry(at);
  const here = byName.get(first.satName);
  const there = first.nearestName ? byName.get(first.nearestName) : undefined;
  if (sun && here && there) {
    const a = propagate(here, at);
    const b = propagate(there, at);
    if (a && b && typeof a.position !== "boolean" && typeof b.position !== "boolean" && typeof a.velocity !== "boolean" && typeof b.velocity !== "boolean") {
      const manual = chordKm(a.position, b.position);
      console.log("    chord, recomputed " + manual.toFixed(2) + " km  (delta " + Math.abs(manual - (first.distanceKm as number)).toExponential(2) + ")");
      const stateA = illuminationOf(a.position, a.velocity, sun, AXIS);
      const stateB = illuminationOf(b.position, b.velocity, sun, AXIS);
      console.log("    states            " + first.satName + "=" + (stateA?.state ?? "?") + ", " + first.nearestName + "=" + (stateB?.state ?? "?"));
    }
  }

  // Alignment: mean the repo's own illuminationTimeline eclipse fraction over the
  // fleet and compare it to this script's fleet-wide fraction. Same predicate, same
  // grid, so any gap beyond a rounding is a harness bug.
  let repoTotal = 0;
  for (const [name, satrec] of byName) {
    const timeline = illuminationTimeline(satrec, EPOCH, hours * 3600, stepSeconds, AXIS);
    repoTotal += (timeline.fractions.umbra ?? 0) + (timeline.fractions.penumbra ?? 0);
    void name;
  }
  const repoFraction = repoTotal / Math.max(1, byName.size);
  console.log(
    "  alignment:          script " +
      (result.eclipseFraction * 100).toFixed(3) +
      "% vs illuminationTimeline " +
      (repoFraction * 100).toFixed(3) +
      "%  (gap " +
      Math.abs(result.eclipseFraction - repoFraction).toExponential(2) +
      ")",
  );
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
    console.log("usage: eclipse-neighbor.ts [run [hours] [stepSeconds]] | selfcheck");
    return;
  }
  const hours = Number(argv[1] ?? DEFAULT_HOURS);
  const stepSeconds = Number(argv[2] ?? DEFAULT_STEP_SECONDS);
  const results = SCENARIOS.map((scenario) => runScenario(scenario, hours, stepSeconds));
  printSummary(results);
  printRemaining(results);
  const baseline = SCENARIOS[0] as Scenario;
  const migration = migrationScenarios(baseline).map((scenario) => runScenario(scenario, hours, stepSeconds));
  printMigration(results[0] as ScenarioResult, migration);
  writeCsv([...results, ...migration]);
}

main(process.argv.slice(2));

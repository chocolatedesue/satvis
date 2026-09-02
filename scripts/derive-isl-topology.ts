// Which inter-satellite link pattern holds a Walker fleet together, and which
// one quietly falls apart? This script derives the answer by propagation rather
// than assertion: it expands the same Walker patterns the orbit lab generates,
// flies them with SGP4 (satellite.js, the same library the app propagates with),
// and scores each candidate topology on the two things "stable connection" can
// mean:
//
//   - **Length discipline** — how far a link stretches and squeezes over an
//     orbit (mean / min / max in km, plus the coefficient of variation),
//     because a topology whose links span from 0 to a planetary chord is not a
//     topology, it is a flash.
//   - **Identity stability** — how often each satellite's *nearest* satellite
//     in the neighbouring plane changes from one sample to the next (churn per
//     satellite per sample). A link whose endpoints stay put can be installed
//     once and left alone; one whose nearest neighbour rotates has to be
//     re-wired forever, which is the station-keeping bill real constellations
//     pay in the plane-precession terms they burn propellant to cancel.
//
//   node scripts/derive-isl-topology.mjs
//
// Node >= 24 strips the types of the imported src modules natively, the same
// way worker/scripts/update-static-gp.mjs runs the worker's TS pipeline.
//
// The conclusions this prints are what src/modules/util/constellationLinks.ts
// encodes: rings inside every plane, same-slot links between planes whose orbit
// planes rotate the same way, the wrap link dropped when they do not (the
// Walker Star seam), and nothing at all between different shells.

import { json2satrec, propagate } from "satellite.js";

import { hasLineOfSight } from "../src/modules/util/migration.ts";
import { walkerDeltaRecords, WALKER_EPOCH_ISO, type WalkerDeltaParams } from "../src/modules/util/walkerDelta.ts";

const EPOCH = new Date(WALKER_EPOCH_ISO);

type Vec = { x: number; y: number; z: number };
type Frame = Map<string, Vec>;

/** Propagate the whole pattern, one frame per sample: name → TEME position in km. */
function fly(params: WalkerDeltaParams, periods: number, stepSeconds: number): Frame[] {
  const radiusKm = 6378.135 + params.altitudeKm;
  const periodSeconds = 2 * Math.PI * Math.sqrt(radiusKm ** 3 / 398600.8);
  const count = Math.floor((periodSeconds * periods) / stepSeconds);
  const records = walkerDeltaRecords(params, EPOCH, "W", 900000);
  const satrecs = records.filter((r) => r.kind === "omm").map((r) => ({ name: r.omm.OBJECT_NAME, satrec: json2satrec(r.omm) }));
  return Array.from({ length: count + 1 }, (_, at) => {
    const time = new Date(EPOCH.getTime() + at * stepSeconds * 1000);
    const frame: Frame = new Map();
    for (const { name, satrec } of satrecs) {
      const state = propagate(satrec, time);
      if (state?.position) {
        frame.set(name, state.position);
      }
    }
    return frame;
  });
}

function chord(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function stats(lengths: number[]): { mean: number; min: number; max: number; cv: number } {
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  return { mean, min, max, cv: Math.sqrt(variance) / mean };
}

function nameOf(_params: WalkerDeltaParams, plane: number, slot: number): string {
  return `W P${String(plane + 1).padStart(2, "0")}-${String(slot + 1).padStart(2, "0")}`;
}

/** The candidate link families inside one pattern. "inter+seam" adds the wrap link even when the wrap planes oppose. */
function linksFor(params: WalkerDeltaParams, kind: "intra" | "inter" | "inter+seam"): Array<[string, string]> {
  const perPlane = Math.round(params.total / params.planes);
  const links: Array<[string, string]> = [];
  for (let plane = 0; plane < params.planes; plane += 1) {
    for (let slot = 0; slot < perPlane; slot += 1) {
      if (kind === "intra") {
        links.push([nameOf(params, plane, slot), nameOf(params, plane, (slot + 1) % perPlane)]);
      } else {
        const next = plane + 1;
        if (next < params.planes) {
          links.push([nameOf(params, plane, slot), nameOf(params, next, slot)]);
        } else if (kind === "inter+seam") {
          links.push([nameOf(params, plane, slot), nameOf(params, 0, slot)]);
        }
      }
    }
  }
  return links;
}

interface Report {
  label: string;
  links: number;
  meanKm: number;
  minKm: number;
  maxKm: number;
  cv: number;
  occluded: number;
  churn: number;
}

function scoreLinks(label: string, params: WalkerDeltaParams, kind: "intra" | "inter" | "inter+seam", frames: Frame[]): Report {
  const links = linksFor(params, kind);
  const lengths: number[] = [];
  let occluded = 0;
  let samples = 0;
  for (const frame of frames) {
    for (const [a, b] of links) {
      const pa = frame.get(a);
      const pb = frame.get(b);
      if (!pa || !pb) {
        continue;
      }
      lengths.push(chord(pa, pb));
      samples += 1;
      // hasLineOfSight speaks metres (see migration.ts); satellite.js speaks km.
      const toMetres = (v: Vec) => ({ x: v.x * 1000, y: v.y * 1000, z: v.z * 1000 });
      if (!hasLineOfSight(toMetres(pa), toMetres(pb), 0)) {
        occluded += 1;
      }
    }
  }
  const s = stats(lengths);
  // Identity churn: how often the nearest satellite in the neighbouring set is
  // a different satellite from one sample to the next.
  let changes = 0;
  let comparisons = 0;
  const perPlane = Math.round(params.total / params.planes);
  for (let plane = 0; plane < params.planes; plane += 1) {
    for (let slot = 0; slot < perPlane; slot += 1) {
      const source = nameOf(params, plane, slot);
      let candidates: string[];
      if (kind === "intra") {
        candidates = [];
        for (let other = 0; other < perPlane; other += 1) {
          if (other !== slot && other !== (slot + 1) % perPlane && other !== (slot - 1 + perPlane) % perPlane) {
            candidates.push(nameOf(params, plane, other));
          }
        }
      } else {
        const target = plane + 1 < params.planes ? plane + 1 : kind === "inter+seam" ? 0 : -1;
        if (target < 0) {
          continue;
        }
        candidates = Array.from({ length: perPlane }, (_, other) => nameOf(params, target, other));
      }
      let previous: string | undefined;
      let first = true;
      for (const frame of frames) {
        const pa = frame.get(source);
        if (!pa) {
          continue;
        }
        let best: string | undefined;
        let bestKm = Infinity;
        for (const candidate of candidates) {
          const pc = frame.get(candidate);
          if (!pc) {
            continue;
          }
          const km = chord(pa, pc);
          if (km < bestKm) {
            bestKm = km;
            best = candidate;
          }
        }
        if (!first && best !== previous) {
          changes += 1;
        }
        previous = best;
        first = false;
        comparisons += 1;
      }
    }
  }
  return {
    label,
    links: links.length,
    meanKm: s.mean,
    minKm: s.min,
    maxKm: s.max,
    cv: s.cv,
    occluded: samples > 0 ? occluded / samples : 0,
    churn: comparisons > 0 ? changes / comparisons : 0,
  };
}

function printHeader(): void {
  console.log(["topology", "links", "mean km", "min km", "max km", "len CV", "occluded", "churn"].map((h) => h.padEnd(13)).join(""));
}

function printRow(r: Report): void {
  console.log(
    [r.label, String(r.links), r.meanKm.toFixed(0), r.minKm.toFixed(0), r.maxKm.toFixed(0), r.cv.toFixed(3), `${(r.occluded * 100).toFixed(1)}%`, r.churn.toFixed(3)]
      .map((c) => c.padEnd(13))
      .join(""),
  );
}

// ---------------------------------------------------------------------------
// Study 1 — the stacked-shells demo fleet, low shell
// ---------------------------------------------------------------------------

console.log("== study 1: 53:24/4/1@550 (Delta, P=4, S=6, F=1) — 3 orbits, 60 s steps ==");
{
  const params: WalkerDeltaParams = { total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
  const frames = fly(params, 3, 60);
  printHeader();
  printRow(scoreLinks("intra ring", params, "intra", frames));
  printRow(scoreLinks("inter same-slot", params, "inter", frames));
  printRow(scoreLinks("inter + wrap", params, "inter+seam", frames));
}

console.log("");
console.log("== study 2: 70:24/4/1@1200 (Delta) — the same-period high shell ==");
{
  const params: WalkerDeltaParams = { total: 24, planes: 4, phasing: 1, inclinationDeg: 70, altitudeKm: 1200, raanSpanDeg: 360 };
  const frames = fly(params, 3, 60);
  printHeader();
  printRow(scoreLinks("intra ring", params, "intra", frames));
  printRow(scoreLinks("inter same-slot", params, "inter", frames));
}

console.log("");
console.log("== study 3: cross-shell links (53:24/4/1@550 vs 97.6:24/4/1@1200) — nearest in the other shell, 6 orbits ==");
{
  const low: WalkerDeltaParams = { total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
  const high: WalkerDeltaParams = { total: 24, planes: 4, phasing: 1, inclinationDeg: 97.6, altitudeKm: 1200, raanSpanDeg: 360 };
  const lowFrames = fly(low, 6, 60);
  const highFrames = fly(high, 6, 60);
  const previousBest = new Map<string, string>();
  let changes = 0;
  let comparisons = 0;
  const lengths: number[] = [];
  for (let at = 0; at < lowFrames.length; at += 1) {
    const a = lowFrames[at];
    const b = highFrames[at];
    if (!a || !b) {
      continue;
    }
    for (const [name, pa] of a) {
      let best: string | undefined;
      let bestKm = Infinity;
      for (const [other, pb] of b) {
        const km = chord(pa, pb);
        if (km < bestKm) {
          bestKm = km;
          best = other;
        }
      }
      if (best) {
        lengths.push(bestKm);
        if (previousBest.has(name) && previousBest.get(name) !== best) {
          changes += 1;
        }
        previousBest.set(name, best);
        comparisons += 1;
      }
    }
  }
  const s = stats(lengths);
  printHeader();
  printRow({ label: "cross-shell", links: 24, meanKm: s.mean, minKm: s.min, maxKm: s.max, cv: s.cv, occluded: NaN, churn: changes / comparisons });
  console.log("(different periods: the along-track offset drifts monotonically, so the nearest neighbour never settles)");
}

console.log("");
console.log("== study 4: Iridium-like Walker Star 86.4:66/6/2@780~180 — does the wrap seam hold? ==");
{
  const params: WalkerDeltaParams = { total: 66, planes: 6, phasing: 2, inclinationDeg: 86.4, altitudeKm: 780, raanSpanDeg: 180 };
  const frames = fly(params, 2, 120);
  printHeader();
  printRow(scoreLinks("intra ring", params, "intra", frames));
  printRow(scoreLinks("inter no-wrap", params, "inter", frames));
  printRow(scoreLinks("inter + wrap", params, "inter+seam", frames));
}

console.log("");
console.log("== study 5: phasing F vs stability — 53:24/4/F@550, F = 1, 3, 5 (S = 6, half-spacing = 3 slots) ==");
{
  printHeader();
  for (const phasing of [1, 3, 5]) {
    const params: WalkerDeltaParams = { total: 24, planes: 4, phasing, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
    const frames = fly(params, 2, 60);
    printRow(scoreLinks(`F=${phasing} inter`, params, "inter", frames));
  }
  console.log("(F·360/T is the constant along-track offset to the same-slot neighbour; that neighbour stays the nearest while the offset holds under 180°/S)");
}

console.log("");
console.log("== rule: how many satellites per plane before the ring chord clears the Earth? ==");
{
  const R = 6378.135;
  for (const altitudeKm of [550, 780, 1200]) {
    const a = R + altitudeKm;
    const minS = Math.ceil(Math.PI / Math.acos(R / a));
    console.log(`  altitude ${String(altitudeKm).padEnd(5)} km  ->  S >= ${minS} per plane (a·cos(pi/S) > R)`);
  }
  console.log("(below this, intra-plane links pass through the Earth — study 1's 550 km S=6 ring is 100% occluded)");
}

console.log("");
console.log("== study 6: can a cluster span orbits at all? marked-pair distance over 10 orbits ==");
{
  const at1200a: WalkerDeltaParams = { total: 24, planes: 4, phasing: 1, inclinationDeg: 70, altitudeKm: 1200, raanSpanDeg: 360 };
  const at1200b: WalkerDeltaParams = { total: 24, planes: 4, phasing: 1, inclinationDeg: 97.6, altitudeKm: 1200, raanSpanDeg: 360 };
  const at550: WalkerDeltaParams = { total: 40, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
  const mark = (params: WalkerDeltaParams, plane: number, slot: number) => `W P${String(plane + 1).padStart(2, "0")}-${String(slot + 1).padStart(2, "0")}`;

  // Same period, different plane AND different inclination: 70 deg vs 97.6 deg, both 1200 km.
  const a = fly(at1200a, 10, 60);
  const b = fly(at1200b, 10, 60);
  const c = fly(at550, 10, 60);
  const pairDistance = (x: Frame[], y: Frame[], xa: string, ya: string) =>
    x.map((frame, at) => {
      const pa = frame.get(xa);
      const pb = y[at]?.get(ya);
      return pa && pb ? chord(pa, pb) : NaN;
    });

  const samePeriod = pairDistance(a, b, mark(at1200a, 0, 0), mark(at1200b, 0, 0)).filter(Number.isFinite);
  const drift = pairDistance(a, c, mark(at1200a, 0, 0), mark(at550, 0, 0)).filter(Number.isFinite);
  const perOrbitMax = (series: number[], periodSamples: number) => {
    const maxima: number[] = [];
    for (let at = 0; at + periodSamples <= series.length; at += periodSamples) {
      maxima.push(Math.max(...series.slice(at, at + periodSamples)));
    }
    return maxima;
  };
  const periodSamples = 96; // ~95.6 min at 60 s steps for the 550 km shell; the 1200 km pair shares the 110 min period, close enough for an envelope read
  const sSame = stats(samePeriod);
  const sDrift = stats(drift);
  printHeader();
  printRow({ label: "same period", links: 1, meanKm: sSame.mean, minKm: sSame.min, maxKm: sSame.max, cv: sSame.cv, occluded: NaN, churn: 0 });
  printRow({ label: "diff period", links: 1, meanKm: sDrift.mean, minKm: sDrift.min, maxKm: sDrift.max, cv: sDrift.cv, occluded: NaN, churn: 1 });
  console.log(
    `  same-period pair, per-orbit distance maxima: ${perOrbitMax(samePeriod, periodSamples)
      .map((m) => m.toFixed(0))
      .join(", ")} km`,
  );
  console.log(
    `  diff-period pair, per-orbit distance maxima: ${perOrbitMax(drift, periodSamples)
      .map((m) => m.toFixed(0))
      .join(", ")} km`,
  );
  console.log("(same period: the envelope repeats, the pair never parts. different period: the maxima wander without bound)");
}

// ---------------------------------------------------------------------------
// Studies 7-10 — multi-shell layouts: which second shell holds against the first
//
// Studies 1-6 stayed inside one shell, and study 3 stopped at "different shells
// drift". That was a measurement of the *shells that were tried*, not a law, and
// src/modules/util/shellLayout.ts is the law it was missing: two shells hold a
// fixed relative arrangement when their nodes precess at the same rate, and they
// return to the same relative phase when their along-track rates are in a
// small-integer ratio. Both are closed form, and both are checked here against
// the propagator rather than against themselves.
// ---------------------------------------------------------------------------

import {
  coPrecessingCeilingKm,
  coPrecessingInclinationDeg,
  familyCycleHours,
  findStableClusters,
  minSatellitesPerRing,
  nodeLockedGroups,
  resonantCompanion,
  searchStableShellLayouts,
  shellFamily,
  shellPairLayout,
  shellRates,
  type ShellOrbit,
} from "../src/modules/util/shellLayout.ts";

/** The reference shell every layout study is measured against. */
const REFERENCE: ShellOrbit = { altitudeKm: 550, inclinationDeg: 53 };

/** The pattern shape the layout studies fly: 4 planes, enough per plane for the rings to clear the ground. */
function shellPattern(orbit: ShellOrbit): WalkerDeltaParams {
  const perPlane = Math.max(minSatellitesPerRing(orbit.altitudeKm), 6);
  return { total: perPlane * 4, planes: 4, phasing: 1, inclinationDeg: orbit.inclinationDeg, altitudeKm: orbit.altitudeKm, raanSpanDeg: 360 };
}

function satrecsOf(params: WalkerDeltaParams): Array<{ name: string; satrec: ReturnType<typeof json2satrec> }> {
  return walkerDeltaRecords(params, EPOCH, "W", 900000)
    .filter((record) => record.kind === "omm")
    .map((record) => ({ name: record.omm.OBJECT_NAME, satrec: json2satrec(record.omm) }));
}

/**
 * The right ascension of a satellite's orbit plane, read off the propagated
 * state vector rather than off the element set: `Ω = atan2(hₓ, −h_y)` from the
 * angular momentum `h = r × v`. This is what makes the node rate a *measurement*
 * — SGP4 is free to disagree with the secular formula, and study 8 is where it
 * says by how much.
 */
function measuredRaanDeg(satrec: ReturnType<typeof json2satrec>, at: Date): number | undefined {
  const state = propagate(satrec, at);
  if (!state?.position || !state.velocity) {
    return undefined;
  }
  const r = state.position;
  const v = state.velocity;
  const hx = r.y * v.z - r.z * v.y;
  const hy = r.z * v.x - r.x * v.z;
  return ((((Math.atan2(hx, -hy) * 180) / Math.PI) % 360) + 360) % 360;
}

/** The node rate SGP4 actually flies, in degrees a day, over `days` of propagation. */
function measuredNodeRateDegPerDay(orbit: ShellOrbit, days = 30, samples = 240): number {
  const { satrec } = satrecsOf(shellPattern(orbit))[0]!;
  let previous = measuredRaanDeg(satrec, EPOCH) ?? 0;
  let unwrapped = previous;
  for (let sample = 1; sample <= samples; sample += 1) {
    const current = measuredRaanDeg(satrec, new Date(EPOCH.getTime() + (sample * days * 86400000) / samples));
    if (current === undefined) {
      continue;
    }
    let step = current - previous;
    while (step > 180) {
      step -= 360;
    }
    while (step < -180) {
      step += 360;
    }
    unwrapped += step;
    previous = current;
  }
  const start = measuredRaanDeg(satrec, EPOCH) ?? 0;
  return (unwrapped - start) / days;
}

/**
 * The argument of latitude — the angle from the ascending node to the satellite,
 * in its own orbit plane. For a circular orbit this *is* the along-track
 * position, and its rate is what decides when two shells return to the same
 * relative phase.
 */
function measuredArgumentOfLatitudeDeg(satrec: ReturnType<typeof json2satrec>, at: Date): number | undefined {
  const state = propagate(satrec, at);
  if (!state?.position || !state.velocity) {
    return undefined;
  }
  const r = state.position;
  const v = state.velocity;
  const h = { x: r.y * v.z - r.z * v.y, y: r.z * v.x - r.x * v.z, z: r.x * v.y - r.y * v.x };
  // The node line is ẑ × h, and h × node completes the in-plane frame.
  const node = { x: -h.y, y: h.x, z: 0 };
  const across = { x: h.y * node.z - h.z * node.y, y: h.z * node.x - h.x * node.z, z: h.x * node.y - h.y * node.x };
  const along = node.x * r.x + node.y * r.y;
  const perpendicular = (across.x * r.x + across.y * r.y + across.z * r.z) / Math.hypot(across.x, across.y, across.z);
  return ((((Math.atan2(perpendicular, along / Math.hypot(node.x, node.y)) * 180) / Math.PI) % 360) + 360) % 360;
}

/** The along-track rate SGP4 actually flies, in degrees a day. */
function measuredAlongTrackRateDegPerDay(orbit: ShellOrbit, days = 2, samples = 4000): number {
  const { satrec } = satrecsOf(shellPattern(orbit))[0]!;
  let previous = measuredArgumentOfLatitudeDeg(satrec, EPOCH) ?? 0;
  let travelled = 0;
  for (let sample = 1; sample <= samples; sample += 1) {
    const current = measuredArgumentOfLatitudeDeg(satrec, new Date(EPOCH.getTime() + (sample * days * 86400000) / samples));
    if (current === undefined) {
      continue;
    }
    let step = current - previous;
    while (step > 180) {
      step -= 360;
    }
    while (step < -180) {
      step += 360;
    }
    travelled += step;
    previous = current;
  }
  return travelled / days;
}

/**
 * The designed companion, closed against the propagator.
 *
 * The secular model gets the altitude to within a few km and the inclination to
 * within a tenth of a degree, and neither error is negligible at the scale the
 * layout is a claim about: a part in two thousand of along-track rate is a degree
 * of phase per repeat cycle, which is 130 km of "the same place". So the two
 * conditions are re-solved against SGP4 itself — altitude for the resonance,
 * inclination for the node lock — alternating, because each moves the other a
 * little. This is what a design does that a derivation cannot: the closed form
 * says where to look, the propagator says where it is.
 */
function refineAgainstSgp4(seed: ShellOrbit, referenceRevolutions: number, companionRevolutions: number): ShellOrbit {
  const wantedRate = (measuredAlongTrackRateDegPerDay(REFERENCE) * companionRevolutions) / referenceRevolutions;
  const referenceNodeRate = measuredNodeRateDegPerDay(REFERENCE);
  let altitudeKm = seed.altitudeKm;
  let inclinationDeg = seed.inclinationDeg;
  for (let pass = 0; pass < 3; pass += 1) {
    // Altitude for the resonance: along-track rate falls with altitude.
    let low = altitudeKm - 40;
    let high = altitudeKm + 40;
    for (let step = 0; step < 22; step += 1) {
      const middle = (low + high) / 2;
      if (measuredAlongTrackRateDegPerDay({ altitudeKm: middle, inclinationDeg }) > wantedRate) {
        low = middle;
      } else {
        high = middle;
      }
    }
    altitudeKm = (low + high) / 2;
    // Inclination for the node lock: a node precesses more slowly the steeper it flies.
    let shallow = Math.max(0, inclinationDeg - 2);
    let steep = Math.min(180, inclinationDeg + 2);
    for (let step = 0; step < 22; step += 1) {
      const middle = (shallow + steep) / 2;
      if (referenceNodeRate - measuredNodeRateDegPerDay({ altitudeKm, inclinationDeg: middle }) > 0) {
        shallow = middle;
      } else {
        steep = middle;
      }
    }
    inclinationDeg = (shallow + steep) / 2;
  }
  return { altitudeKm, inclinationDeg };
}

console.log("");
console.log("== study 7: which second shell can hold against 53:.../4/1@550? ==");
{
  const rates = shellRates(REFERENCE);
  console.log(`  reference node rate ${rates.nodeRateDegPerDay.toFixed(4)} deg/day, period ${rates.periodMinutes.toFixed(2)} min`);
  console.log(`  co-precession ceiling: ${coPrecessingCeilingKm(REFERENCE).toFixed(0)} km — above it no inclination precesses slowly enough to keep up`);
  console.log(["cycle", "altitude km", "inclination", "repeat h", "slip °/cyc", "min S/plane"].map((h) => h.padEnd(14)).join(""));
  for (const layout of searchStableShellLayouts(REFERENCE, { limit: 8 })) {
    console.log(
      [
        `${layout.resonance.referenceRevolutions}:${layout.resonance.companionRevolutions}`,
        layout.altitudeKm.toFixed(1),
        `${layout.inclinationDeg.toFixed(3)}°`,
        layout.resonance.repeatHours.toFixed(3),
        layout.resonance.slipDegPerCycle.toExponential(1),
        String(layout.minPerPlane),
      ]
        .map((cell) => cell.padEnd(14))
        .join(""),
    );
  }
  console.log("(every row is node-locked to the reference by construction; the cycle is what the along-track ratio buys)");
}

const DESIGNED = resonantCompanion(REFERENCE, 8, 7);

console.log("");
console.log("== study 8: does the node lock survive SGP4? 30 days of propagated right ascension ==");
{
  if (!DESIGNED) {
    console.log("  no 8:7 companion — nothing to measure");
  } else {
    const designed: ShellOrbit = { altitudeKm: DESIGNED.altitudeKm, inclinationDeg: DESIGNED.inclinationDeg };
    const candidates: Array<[string, ShellOrbit]> = [
      ["designed 8:7 companion", designed],
      ["same inclination @ 1200", { altitudeKm: 1200, inclinationDeg: 53 }],
      ["the shells demo's 97.6 @ 1200", { altitudeKm: 1200, inclinationDeg: 97.6 }],
      ["the shells demo's 70 @ 1200", { altitudeKm: 1200, inclinationDeg: 70 }],
    ];
    const referenceRate = measuredNodeRateDegPerDay(REFERENCE);
    console.log(`  reference measured node rate ${referenceRate.toFixed(5)} deg/day (secular model: ${shellRates(REFERENCE).nodeRateDegPerDay.toFixed(5)})`);
    console.log(["companion", "predicted °/d", "measured °/d", "shear °/d", "seam holds"].map((h) => h.padEnd(30)).join(""));
    for (const [label, orbit] of candidates) {
      const shear = referenceRate - measuredNodeRateDegPerDay(orbit);
      const days = Math.abs(1 / shear);
      console.log(
        [
          label,
          shellPairLayout(REFERENCE, orbit).nodeShearDegPerDay.toFixed(5),
          measuredNodeRateDegPerDay(orbit).toFixed(5),
          shear.toFixed(5),
          `${days.toFixed(days < 10 ? 2 : 0)} d/deg`,
        ]
          .map((cell) => cell.padEnd(30))
          .join(""),
      );
    }
    const refined = refineAgainstSgp4(designed, 8, 7);
    console.log(
      `  secular design ${designed.altitudeKm.toFixed(1)} km / ${designed.inclinationDeg.toFixed(3)}°` +
        ` -> SGP4-refined ${refined.altitudeKm.toFixed(1)} km / ${refined.inclinationDeg.toFixed(3)}°` +
        ` (${(refined.altitudeKm - designed.altitudeKm).toFixed(1)} km, ${(refined.inclinationDeg - designed.inclinationDeg).toFixed(3)}°)`,
    );
    console.log(`  refined shear ${(referenceRate - measuredNodeRateDegPerDay(refined)).toFixed(5)} deg/day — the lock the design asked for, closed against the propagator`);
  }
}

console.log("");
console.log("== study 9: does the configuration come back? cross-shell nearest neighbour, one repeat cycle apart ==");
{
  if (!DESIGNED) {
    console.log("  no 8:7 companion — nothing to measure");
  } else {
    const cycleSeconds = DESIGNED.resonance.repeatHours * 3600;
    const step = 120;
    const samples = Math.floor(cycleSeconds / step);
    const low = satrecsOf(shellPattern(REFERENCE));
    const secular: ShellOrbit = { altitudeKm: DESIGNED.altitudeKm, inclinationDeg: DESIGNED.inclinationDeg };
    const refined = refineAgainstSgp4(secular, 8, 7);
    const contenders: Array<[string, ShellOrbit]> = [
      ["8:7 refined", refined],
      ["8:7 secular", secular],
      ["same inclination @ 1200", { altitudeKm: 1200, inclinationDeg: 53 }],
      ["shells demo's 97.6 @ 1200", { altitudeKm: 1200, inclinationDeg: 97.6 }],
    ];
    console.log(["companion", "same partner", "range drift km", "median km"].map((h) => h.padEnd(28)).join(""));
    for (const [label, orbit] of contenders) {
      const high = satrecsOf(shellPattern(orbit));
      let same = 0;
      let compared = 0;
      const drift: number[] = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const now = new Date(EPOCH.getTime() + sample * step * 1000);
        const later = new Date(now.getTime() + cycleSeconds * 1000);
        for (const source of low) {
          const before = nearestIn(source.satrec, high, now);
          const after = nearestIn(source.satrec, high, later);
          if (!before || !after) {
            continue;
          }
          compared += 1;
          if (before.name === after.name) {
            same += 1;
          }
          drift.push(Math.abs(before.km - after.km));
        }
      }
      const sorted = drift.toSorted((a, b) => a - b);
      const mean = drift.reduce((a, b) => a + b, 0) / drift.length;
      console.log(
        [label, `${((same / compared) * 100).toFixed(1)}%`, mean.toFixed(0), (sorted[Math.floor(sorted.length / 2)] ?? Number.NaN).toFixed(0)]
          .map((cell) => cell.padEnd(28))
          .join(""),
      );
    }
    console.log("(one cycle later, does each satellite find the same partner at the same range? a repeating layout says yes and a drifting one cannot)");
  }
}

/** The nearest satellite of `fleet` to `source` at `at`, by chord. */
function nearestIn(
  source: ReturnType<typeof json2satrec>,
  fleet: Array<{ name: string; satrec: ReturnType<typeof json2satrec> }>,
  at: Date,
): { name: string; km: number } | undefined {
  const here = propagate(source, at)?.position;
  if (!here) {
    return undefined;
  }
  let best: { name: string; km: number } | undefined;
  for (const { name, satrec } of fleet) {
    const there = propagate(satrec, at)?.position;
    if (!there) {
      continue;
    }
    const km = chord(here, there);
    if (!best || km < best.km) {
      best = { name, km };
    }
  }
  return best;
}

console.log("");
console.log("== study 10: what a co-precessing companion costs — inclination against altitude ==");
{
  console.log(["altitude km", "co-prec i", "period min", "node °/d", "vs reference"].map((h) => h.padEnd(14)).join(""));
  for (const altitudeKm of [400, 550, 700, 900, 1100, 1300, 1500, 1600]) {
    const inclinationDeg = coPrecessingInclinationDeg(REFERENCE, altitudeKm);
    if (inclinationDeg === undefined) {
      console.log(`${String(altitudeKm).padEnd(14)}— above the ceiling`);
      continue;
    }
    const rates = shellRates({ altitudeKm, inclinationDeg });
    console.log(
      [
        String(altitudeKm),
        `${inclinationDeg.toFixed(2)}°`,
        rates.periodMinutes.toFixed(2),
        rates.nodeRateDegPerDay.toFixed(4),
        shellPairLayout(REFERENCE, { altitudeKm, inclinationDeg }).verdict,
      ]
        .map((cell) => cell.padEnd(14))
        .join(""),
    );
  }
  console.log("(the price of the lock is inclination: a companion at 1200 km has to fly at 34.5°, which is coverage a 53° shell already had)");
}

// ---------------------------------------------------------------------------
// Studies 11-12 — clusters: how many shells hold at once, and finding them
//
// Studies 7-10 fixed one companion against one reference. The structural
// question underneath is how many shells can hold *simultaneously*, and the
// answer falls out of the two invariants being equivalence relations: put every
// shell on one node-rate curve and give them one shared cycle, and every pair
// among them repeats without anyone checking pairs. What is left to measure is
// the price — how the count trades against the cycle and against inclination —
// and whether the finder recovers a family it was not told about.
// ---------------------------------------------------------------------------

console.log("");
console.log("== study 11: how many shells hold at once, and what they cost ==");
{
  console.log(["reference", "cycle rev", "shells", "cycle h", "inclination span", "adjacent Δh", "worst slip"].map((h) => h.padEnd(18)).join(""));
  const references: Array<[string, ShellOrbit]> = [
    ["53° / 550 km", { altitudeKm: 550, inclinationDeg: 53 }],
    ["70° / 550 km", { altitudeKm: 550, inclinationDeg: 70 }],
    ["86.4° / 780 km", { altitudeKm: 780, inclinationDeg: 86.4 }],
  ];
  for (const [label, reference] of references) {
    const perDay = shellRates(reference).alongTrackRateDegPerDay / 360;
    for (const days of [1, 2, 3]) {
      const shells = shellFamily(reference, { cycleRevolutions: Math.round(perDay * days) });
      if (shells.length === 0) {
        continue;
      }
      const cycleDays = familyCycleHours(shells) / 24;
      const inclinations = shells.map((shell) => shell.inclinationDeg);
      const altitudes = shells.map((shell) => shell.altitudeKm).toSorted((a, b) => a - b);
      const gaps = altitudes.slice(1).map((altitude, at) => altitude - (altitudes[at] as number));
      let worstSlip = 0;
      for (const shell of shells) {
        const turns = (shellRates(shell).alongTrackRateDegPerDay * cycleDays) / 360;
        worstSlip = Math.max(worstSlip, Math.abs(turns - Math.round(turns)) * 360);
      }
      console.log(
        [
          days === 1 ? label : "",
          String(Math.round(perDay * days)),
          String(shells.length),
          (cycleDays * 24).toFixed(1),
          `${Math.min(...inclinations).toFixed(1)}°–${Math.max(...inclinations).toFixed(1)}°`,
          `${Math.min(...gaps).toFixed(0)}–${Math.max(...gaps).toFixed(0)} km`,
          `${worstSlip.toExponential(1)}°`,
        ]
          .map((cell) => cell.padEnd(18))
          .join(""),
      );
    }
  }
  console.log("(one more shell per ~6 h of cycle at 550 km — the band fixes a period ratio, and the shells are the integers inside it)");
  console.log(
    `(the lever is the reference inclination: ceiling ${coPrecessingCeilingKm({ altitudeKm: 550, inclinationDeg: 53 }).toFixed(0)} km at 53°, ${coPrecessingCeilingKm({ altitudeKm: 780, inclinationDeg: 86.4 }).toFixed(0)} km at 86.4° — matching a node rate near zero costs almost no inclination)`,
  );
}

console.log("");
console.log("== study 12: hand the finder a mixed fleet and see what it calls a cluster ==");
{
  const reference: ShellOrbit = { altitudeKm: 550, inclinationDeg: 53 };
  const family = shellFamily(reference, { cycleRevolutions: 30 });
  const fleet = [
    ...family.map((shell) => ({ id: `family k=${shell.revolutions}`, orbit: { altitudeKm: shell.altitudeKm, inclinationDeg: shell.inclinationDeg } })),
    // The stacked-shells demo's own three, none of which was designed to hold.
    { id: "demo 53/550", orbit: reference },
    { id: "demo 70/1200", orbit: { altitudeKm: 1200, inclinationDeg: 70 } },
    { id: "demo 97.6/1200", orbit: { altitudeKm: 1200, inclinationDeg: 97.6 } },
    // One shell flown twice, which is rigid rather than merely repeating.
    { id: "sso A", orbit: { altitudeKm: 600, inclinationDeg: 97.79 } },
    { id: "sso B", orbit: { altitudeKm: 600, inclinationDeg: 97.79 } },
  ];
  console.log(
    `  fleet of ${fleet.length} orbits; node-locked groups: ${nodeLockedGroups(fleet)
      .map((group) => group.length)
      .join(", ")}`,
  );
  const clusters = findStableClusters(fleet, { maxCycleHours: 48 });
  console.log(["cluster", "members", "cycle h", "node spread °/d", "slip °/cycle"].map((h) => h.padEnd(16)).join(""));
  for (const cluster of clusters) {
    console.log(
      [cluster.verdict, String(cluster.members.length), cluster.cycleHours.toFixed(2), cluster.nodeSpreadDegPerDay.toExponential(1), cluster.slipDegPerCycle.toExponential(1)]
        .map((cell) => cell.padEnd(16))
        .join(""),
    );
    console.log(`      ${cluster.members.join(", ")}`);
  }
  console.log("(the designed family comes back whole — including the demo's 53/550, which is its own reference — and no shell picked for coverage joins anything)");
}

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

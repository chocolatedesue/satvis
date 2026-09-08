// Orbit analysis, off the screen.
//
//   node --experimental-strip-types scripts/research/orbit-lab.ts orbit 550 53
//   node --experimental-strip-types scripts/research/orbit-lab.ts shells 550 53
//   node --experimental-strip-types scripts/research/orbit-lab.ts clusters 550:53,1200:70,600:97.79
//   node --experimental-strip-types scripts/research/orbit-lab.ts formation 650 100 5
//
// Or through pnpm, which supplies the flag: `pnpm orbit-lab orbit 550 53`.
//
// The point of this file is that none of the questions it answers need a globe.
// `src/modules/util/` is Cesium-free and Vue-free on purpose — a circular orbit's
// period, its two secular rates, whether its planes ever escape the shadow and
// which other orbits hold a fixed relation to it are all closed form — so the
// same modules the orbit-lab panel reads can be driven from a terminal, with no
// build step and no browser. Everything printed here is a property of a design,
// not of a date: no drag, no third body, no station-keeping, and the eclipse
// condition is a spherical Earth's umbra.
//
// Node >= 22 strips the types of the imported src modules natively. The one
// constraint that imposes: an import a script can reach has to carry its `.ts`
// extension, because node resolves no specifier a bundler would have to. See the
// header of src/modules/util/orbitModel.ts.

import { clusterRadiusM, clusterSize, maxEccentricity, type ClusterFormationParams } from "../../src/modules/util/clusterFormation.ts";
import { orbitalRates, type CircularOrbit } from "../../src/modules/util/orbitModel.ts";
import { orbitReport } from "../../src/modules/util/orbitReport.ts";
import { findStableClusters, searchStableShellLayouts, type ClusterMember } from "../../src/modules/util/shellLayout.ts";
import { reportDesign, usageDesign } from "./cluster-design.ts";
import { reportCapacity, reportEvaluation, usageCapacity, usageEvaluate } from "./compute-design.ts";

const USAGE = `orbit-lab — closed-form orbit analysis, no globe

  orbit     <altKm> <incDeg>                     one orbit's own numbers
  shells    <altKm> <incDeg> [limit]             companion shells that hold a fixed relation to it
  clusters  <alt:inc>[,<alt:inc>...]             which of several orbits return together
  formation <altKm> <pitchM> <rings> [incDeg]    a free-flying lattice's size (default dawn-dusk SSO)
  ${usageDesign()}
  ${usageCapacity()}
  ${usageEvaluate()}

Altitudes in km, angles in degrees, pitches in metres.`;

/** `550:53` into an orbit. Undefined when either half is missing or not a number. */
function parseOrbit(text: string): CircularOrbit | undefined {
  const [altitudeKm, inclinationDeg] = text.split(":").map(Number);
  if (!Number.isFinite(altitudeKm) || !Number.isFinite(inclinationDeg)) {
    return undefined;
  }
  return { altitudeKm, inclinationDeg };
}

function number(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** Fixed-width columns, so a table read in a terminal lines up. */
function row(cells: (string | number)[], widths: number[]): string {
  return cells.map((cell, index) => String(cell).padEnd(widths[index] ?? 12)).join("");
}

function reportOrbit(orbit: CircularOrbit): void {
  const report = orbitReport(orbit);
  const { rates } = report;
  console.log(`orbit  ${orbit.altitudeKm} km / ${orbit.inclinationDeg}°`);
  console.log(`  period              ${rates.periodMinutes.toFixed(2)} min  (${rates.meanMotionRevPerDay.toFixed(4)} rev/day)`);
  console.log(`  node rate  Ω̇        ${rates.nodeRateDegPerDay.toFixed(4)} °/day`);
  console.log(`  along-track u̇      ${rates.alongTrackRateDegPerDay.toFixed(2)} °/day`);
  console.log("");
  console.log(
    `  sun-synchronous needs  ${report.sunSyncInclinationDeg === undefined ? "no inclination" : `${report.sunSyncInclinationDeg.toFixed(2)}°`}  (sun moves ${report.sunDegPerDay.toFixed(4)} °/day)`,
  );
  console.log(`  β cycle               ${formatCycle(report.betaCycleDays)}`);
  console.log(`  eclipse-free needs |β| ≥ ${report.requiredBetaDeg.toFixed(2)}°;  best any plane here reaches ${report.reachableBetaDeg.toFixed(2)}°`);
  console.log(`  planes eclipse-free, annual  ${(report.eclipseFreePlaneFraction * 100).toFixed(1)}%`);
  console.log("");
  console.log(`  co-precessing ceiling   ${formatKm(report.coPrecessingCeilingKm)}  (above it no companion keeps this node rate)`);
  console.log(`  satellites per ring     ≥ ${report.minSatellitesPerRing}  (before intra-plane links run through the ground)`);
}

function formatCycle(days: number): string {
  if (!Number.isFinite(days)) {
    return "never — the plane never leaves its angle to the sun";
  }
  return `${days.toFixed(1)} days`;
}

function formatKm(km: number): string {
  return Number.isFinite(km) ? `${km.toFixed(0)} km` : "no ceiling (a polar reference matches any altitude)";
}

function reportShells(orbit: CircularOrbit, limit: number): void {
  const layouts = searchStableShellLayouts(orbit, { limit });
  console.log(`companion shells for ${orbit.altitudeKm} km / ${orbit.inclinationDeg}°  (node-locked, and returning on a whole-number cycle)`);
  if (layouts.length === 0) {
    console.log("  none — the altitude band and the co-precession ceiling leave no resonance");
    return;
  }
  console.log(row(["altitude", "incl", "turns", "cycle h", "min/plane", "max link km"], [12, 10, 14, 10, 12, 14]));
  for (const layout of layouts) {
    console.log(
      row(
        [
          `${layout.altitudeKm.toFixed(1)} km`,
          `${layout.inclinationDeg.toFixed(2)}°`,
          `${layout.resonance.referenceRevolutions}:${layout.resonance.companionRevolutions}`,
          layout.resonance.repeatHours.toFixed(2),
          String(layout.minPerPlane),
          layout.maxLinkRangeKm.toFixed(0),
        ],
        [12, 10, 14, 10, 12, 14],
      ),
    );
  }
  console.log("(turns are reference:companion revolutions per cycle; the pair's whole geometry comes back every cycle)");
}

function reportClusters(orbits: CircularOrbit[]): void {
  const members: ClusterMember[] = orbits.map((orbit) => ({ id: `${orbit.altitudeKm}/${orbit.inclinationDeg}`, orbit }));
  if (members.length < 2) {
    console.log("clusters needs at least two orbits — `clusters 550:53,1200:70`");
    return;
  }
  const clusters = findStableClusters(members);
  console.log(`${orbits.length} orbits; maximal stable clusters: ${clusters.length}`);
  if (clusters.length === 0) {
    console.log("  none — no subset shares a node rate and closes one shared cycle");
    return;
  }
  console.log(row(["verdict", "members", "cycle h", "slip °/cycle", "node spread °/d"], [12, 10, 10, 14, 18]));
  for (const cluster of clusters) {
    console.log(
      row(
        [cluster.verdict, String(cluster.members.length), cluster.cycleHours.toFixed(2), cluster.slipDegPerCycle.toExponential(1), cluster.nodeSpreadDegPerDay.toExponential(1)],
        [12, 10, 10, 14, 18],
      ),
    );
    console.log(`      ${cluster.members.join(", ")}`);
  }
}

function reportFormation(params: ClusterFormationParams): void {
  const { altitudeKm, pitchM, rings } = params;
  console.log(`formation lattice  ${rings} ring(s) at ${pitchM} m pitch, ${altitudeKm} km`);
  console.log(`  satellites      ${clusterSize(rings)}`);
  console.log(`  radius  R       ${clusterRadiusM(params).toFixed(0)} m  (the epicycle is twice as wide along-track as it is tall)`);
  console.log(`  outer member e  ${maxEccentricity(params).toExponential(2)}  (the formation's size, as an element)`);
  const rates = orbitalRates(params);
  console.log(`  period          ${rates.periodMinutes.toFixed(2)} min — one epicycle per orbit`);
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  if (command === "orbit") {
    const orbit = parseOrbit(`${rest[0] ?? ""}:${rest[1] ?? ""}`);
    if (!orbit) {
      console.log(USAGE);
      return;
    }
    reportOrbit(orbit);
    return;
  }

  if (command === "shells") {
    const orbit = parseOrbit(`${rest[0] ?? ""}:${rest[1] ?? ""}`);
    if (!orbit) {
      console.log(USAGE);
      return;
    }
    reportShells(orbit, number(rest[2]) ?? 6);
    return;
  }

  if (command === "clusters") {
    const orbits = (rest[0] ?? "").split(",").map(parseOrbit);
    if (orbits.some((orbit) => orbit === undefined)) {
      console.log(USAGE);
      return;
    }
    reportClusters(orbits.filter((orbit): orbit is CircularOrbit => orbit !== undefined));
    return;
  }

  if (command === "formation") {
    const altitudeKm = number(rest[0]);
    const pitchM = number(rest[1]);
    const rings = number(rest[2]);
    if (altitudeKm === undefined || pitchM === undefined || rings === undefined) {
      console.log(USAGE);
      return;
    }
    // Dawn-dusk sun-synchronous by default, because that is what a formation is
    // designed for — a cluster is a compute cluster, and it wants the sun. Any
    // other inclination is a 4th argument.
    reportFormation({ altitudeKm, inclinationDeg: number(rest[3]) ?? 97.99, pitchM, rings });
    return;
  }

  if (command === "design") {
    const orbit = parseOrbit(`${rest[0] ?? ""}:${rest[1] ?? ""}`);
    const perPlane = number(rest[2]) ?? 20;
    if (!orbit) {
      console.log(USAGE);
      return;
    }
    reportDesign(orbit, perPlane);
    return;
  }

  if (command === "capacity") {
    const orbit = parseOrbit(rest[0] ?? "");
    if (!orbit) {
      console.log(USAGE);
      return;
    }
    reportCapacity(orbit, number(rest[1]) ?? 60, number(rest[2]) ?? 8, number(rest[3]) ?? 4);
    return;
  }

  if (command === "evaluate") {
    const orbit = parseOrbit(rest[0] ?? "");
    if (!orbit) {
      console.log(USAGE);
      return;
    }
    reportEvaluation(orbit, number(rest[1]) ?? 60, number(rest[2]) ?? 8, number(rest[3]) ?? 4);
    return;
  }

  console.log(`unknown command: ${command}`);
  console.log(USAGE);
}

main(process.argv.slice(2));

// What one orbit gives you, as the laws that decide it.
//
// The point of this file is that the three questions a compute cluster asks —
// will the geometry hold, how much power is there, how deep can the inference
// pipeline be — are all answerable from an altitude and an inclination, in closed
// form, before anything is built. This prints them together, because designing
// against them one at a time is how a shell ends up with a pipeline deeper than
// its own sunlit arc.
//
//   node --experimental-strip-types scripts/research/orbit-lab.ts design <altKm> <incDeg> <satsPerPlane>
//
// See docs/cluster-math.md for the derivations and docs/orbital-compute.md for
// how the three layers fit together.

import { arcLengthM, ballisticCoefficient, differentialDragDriftM } from "../../src/modules/util/differentialDrag.ts";
import { fullyLitFraction, optimalPipelineDepth } from "../../src/modules/util/energyTrace.ts";
import { annualEclipseFreePlaneFraction, maxReachableBetaDeg } from "../../src/modules/util/orbitDesign.ts";
import { orbitalRates, type CircularOrbit } from "../../src/modules/util/orbitModel.ts";
import { coPrecessingCeilingKm, minSatellitesPerRing } from "../../src/modules/util/shellLayout.ts";
import { betaCycleDays, eclipseFreeBetaDeg, sunSyncInclinationDeg, SUN_DEG_PER_DAY } from "../../src/modules/util/sunSynchronous.ts";

/** The per-stage KV working set and the single ISL rate the migration model assumes. */
const KV_GIGABYTES = 2;
const ISL_GBPS = 100;

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

/** The design report, printed for one orbit and one ring size. */
export function reportDesign(orbit: CircularOrbit, satsPerPlane: number): void {
  const { altitudeKm, inclinationDeg } = orbit;
  const rates = orbitalRates(orbit);
  const betaNeeded = eclipseFreeBetaDeg(altitudeKm);
  const betaReachable = maxReachableBetaDeg(inclinationDeg);
  const neverEclipsed = annualEclipseFreePlaneFraction(orbit);

  console.log(`design  ${altitudeKm} km / ${inclinationDeg}°  ·  ${satsPerPlane} satellites per plane`);
  console.log("");

  console.log("-- geometry: what holds relative to what --");
  console.log(`  period                ${fixed(rates.periodMinutes, 2)} min   (${fixed(rates.meanMotionRevPerDay, 4)} rev/day)`);
  console.log(`  node rate  Ω̇          ${fixed(rates.nodeRateDegPerDay, 4)} °/day`);
  console.log(`  along-track u̇        ${fixed(rates.alongTrackRateDegPerDay, 2)} °/day`);
  console.log(`  co-precession ceiling ${fixed(coPrecessingCeilingKm(orbit), 0)} km`);
  console.log(`  sats per ring, min    ${minSatellitesPerRing(altitudeKm)}   (before intra-plane links run through the ground)`);
  console.log(`  sun-sync inclination  ${sunSyncInclinationDeg(altitudeKm) === undefined ? "—" : `${fixed(sunSyncInclinationDeg(altitudeKm)!, 2)}°`}`);
  console.log("");

  console.log("-- energy: how much of it is lit --");
  console.log(`  β needed to clear shadow   ${fixed(betaNeeded, 2)}°`);
  console.log(
    `  β reachable, best moment   ${fixed(betaReachable, 2)}°   ${betaReachable >= betaNeeded ? "(a well-placed plane can be eclipse-free)" : "(never eclipse-free at any node)"}`,
  );
  console.log(`  planes never eclipsed      ${fixed(neverEclipsed * 100, 1)}%   (annual average, over node phase)`);
  console.log(`  β cycle                    ${Number.isFinite(betaCycleDays(orbit)) ? `${fixed(betaCycleDays(orbit), 1)} days` : "frozen — quasi-sun-synchronous"}`);
  console.log(`  sun's own rate             ${fixed(SUN_DEG_PER_DAY, 4)} °/day`);
  console.log("");

  // The eclipse fraction the pipeline sees. "Planes never eclipsed" is the share
  // of node phases that are *free* of eclipse; what bounds a pipeline is the
  // complement on the rest — a plane that is eclipsed at all loses about a third
  // of every revolution, which is the number the two formulas below want.
  const fEcl = (1 - neverEclipsed) * (1 / 3);
  const depth = optimalPipelineDepth(satsPerPlane, fEcl);
  console.log("-- inference: how deep the pipeline can be --");
  console.log(`  eclipse fraction, a lit plane's complement  ${fixed(fEcl * 100, 1)}%`);
  console.log(`  optimal depth  P* = ⌊N(1−f_ecl)⌋           ${depth} of ${satsPerPlane} stages`);
  for (const probe of [1, 2, 4, Math.max(1, Math.floor(depth / 2)), depth, depth + 1]) {
    if (probe > satsPerPlane + 1 || probe < 1) {
      continue;
    }
    const served = fullyLitFraction(satsPerPlane, fEcl, probe);
    console.log(`    P = ${String(probe).padStart(2)}  →  all stages lit ${fixed(served * 100, 1)}% of the time`);
  }
  console.log(`  KV per stage   ${KV_GIGABYTES} GB over ${ISL_GBPS} Gbps  =  ${fixed((KV_GIGABYTES * 8 * 1000) / ISL_GBPS, 0)} ms per handoff`);
  console.log("");

  console.log("-- drag: how long the vacuum holds --");
  const deltaB = ballisticCoefficient(0.05) * 0.1;
  for (const hours of [1, 6, 24, 48]) {
    const drift = differentialDragDriftM(altitudeKm, deltaB, hours * 3600);
    console.log(`  ${String(hours).padStart(2)} h, 10% spread in C_d·A/m  →  ${fixed(drift, 1)} m   (1° of phase = ${fixed(arcLengthM(altitudeKm, 1), 0)} m)`);
  }
}

/** One line for the usage block, so the two cannot drift apart. */
export function usageDesign(): string {
  return "design    <altKm> <incDeg> <satsPerPlane>   what one orbit gives you: geometry, energy, pipeline depth, drag";
}

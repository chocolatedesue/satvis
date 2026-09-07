// How big is the hole? A drag budget for the two stability claims.
//
// Everything in this repository's cluster maths is secular J₂ in a vacuum. The
// unresolved question is whether that is enough: at 550–650 km there is still
// air, and two satellites that differ in area-to-mass do not lose altitude at
// the same rate — which is a phase difference, and phase differences are what
// both stability claims are made of.
//
// This computes the size of that effect. It is an order-of-magnitude budget, not
// a forecast: exponential atmosphere, fixed ballistic coefficients, circular
// orbits, no attitude or solar-activity modelling beyond a range.
//
//   node --experimental-strip-types scripts/drag-budget.ts

import { clusterRadiusM } from "../src/modules/util/clusterFormation.ts";
import { orbitalRates, WGS72_EARTH_RADIUS_KM, WGS72_MU_KM3_S2 } from "../src/modules/util/orbitModel.ts";

/** An exponential atmosphere, pinned at 550 km and scaled by one scale height. */
const RHO_550_KG_M3 = 2e-12;
const SCALE_HEIGHT_KM = 65;

function densityAt(altitudeKm: number, rho550 = RHO_550_KG_M3): number {
  return rho550 * Math.exp(-(altitudeKm - 550) / SCALE_HEIGHT_KM);
}

/**
 * Along-track separation two satellites accumulate from a difference in
 * ballistic coefficient alone.
 *
 * `ȧ = −ρ B √(μ a)`, so a difference ΔB opens a semi-major axis difference at
 * `Δȧ = −ρ ΔB √(μ a)`. A semi-major axis difference is a mean-motion
 * difference, `Δn = (3/2)(n/a)Δa`, and that is a along-track rate. Δa grows
 * linearly in t and the drift is its integral, so the separation goes as t²:
 *
 *   Δs = (3/4) · n · ρ ΔB √(μ a) · t²
 *
 * The t² is the thing to notice. Everything else in this repository's model is
 * a rate; this is an acceleration of the separation itself.
 */
function driftMetres(altitudeKm: number, deltaB: number, seconds: number, rho550 = RHO_550_KG_M3): number {
  const a = (WGS72_EARTH_RADIUS_KM + altitudeKm) * 1000;
  const mu = WGS72_MU_KM3_S2 * 1e9;
  const n = Math.sqrt(mu / (a * a * a));
  const rateOfAxisChange = densityAt(altitudeKm, rho550) * deltaB * Math.sqrt(mu * a);
  return 0.75 * n * rateOfAxisChange * seconds * seconds;
}

function metres(x: number): string {
  if (x >= 1000) {
    return `${(x / 1000).toFixed(1)} km`;
  }
  return `${x.toFixed(2)} m`;
}

console.log("Differential-drag budget — is the vacuum good enough?\n");
console.log(`atmosphere: ρ(550 km) = ${RHO_550_KG_M3.toExponential(1)} kg/m³, H = ${SCALE_HEIGHT_KM} km (exponential)`);
console.log("ΔB is the spread in ballistic coefficient C_d·A/m between two members, in m²/kg\n");

// ---- 1. the stable-cluster claim: does a 48 h cycle survive? ----
console.log("== stable clusters: slip budget is REPEAT_SLIP_TOLERANCE_DEG = 1° ==");
for (const altitudeKm of [550, 780, 1200]) {
  const a = WGS72_EARTH_RADIUS_KM + altitudeKm;
  const budget = (a * Math.PI) / 180; // 1° of arc at this radius, in km
  console.log(`\n  ${altitudeKm} km — 1° of along-track arc = ${metres(budget * 1000)}`);
  for (const spread of [0.02, 0.1, 0.3]) {
    // A satellite with A/m = 0.05 m²/kg and C_d = 2.2 has B = 0.11; `spread` is
    // the fractional disagreement between two members.
    const deltaB = 0.11 * spread;
    const over48h = driftMetres(altitudeKm, deltaB, 48 * 3600);
    const verdict = over48h < budget * 1000 ? "holds" : "BREAKS";
    console.log(`    ${String(spread * 100).padStart(3)}% spread: ${metres(over48h).padStart(9)} over 48 h   ${verdict}`);
  }
}

// ---- 2. the formation claim: does the lattice survive one orbit? ----
console.log("\n== formation: the Suncatcher lattice, 100 m spacing, R = 1 km ==");
const suncatcher = { inclinationDeg: 97.99, altitudeKm: 650, pitchM: 100, rings: 5 };
const rates = orbitalRates(suncatcher);
const period = rates.periodMinutes * 60;
console.log(`  ${clusterRadiusM(suncatcher)} m radius, period ${rates.periodMinutes.toFixed(1)} min\n`);
for (const spread of [0.02, 0.1, 0.3]) {
  const deltaB = 0.11 * spread;
  console.log(
    `    ${String(spread * 100).padStart(3)}% spread: ${metres(driftMetres(650, deltaB, period)).padStart(9)} after 1 orbit` +
      `   ${metres(driftMetres(650, deltaB, 5 * period)).padStart(9)} after 5`,
  );
}
console.log("  (compare: 100 m lattice spacing, and the measured ~8 m static J₂ distortion)");

// ---- 3. sensitivity to solar activity ----
console.log("\n== solar activity, at 10% spread ==");
for (const [label, rho] of [
  ["solar minimum", 2e-13],
  ["moderate", 2e-12],
  ["solar maximum", 1.5e-11],
] as const) {
  const cluster = driftMetres(550, 0.11 * 0.1, 48 * 3600, rho);
  const formation = driftMetres(650, 0.11 * 0.1, period, rho);
  console.log(`  ${label.padEnd(15)} ρ550=${rho.toExponential(1)}  cluster/48h ${metres(cluster).padStart(9)}   formation/orbit ${metres(formation).padStart(9)}`);
}

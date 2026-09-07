// Differential drag, as a law rather than as a script.
//
// Everything else in this folder's cluster maths is secular J₂ in a vacuum. At
// 550–650 km there is still air, and two satellites that differ in area-to-mass
// do not lose altitude at the same rate — which is a phase difference, and phase
// differences are what both stability claims are made of. So the size of that
// effect is part of the model, not a footnote.
//
// It is an order-of-magnitude law, not a forecast: exponential atmosphere, fixed
// ballistic coefficients, circular orbits, no attitude, and solar activity
// carried as a single density parameter rather than a model.

import { WGS72_EARTH_RADIUS_KM, WGS72_MU_KM3_S2, circularSemiMajorAxisKm } from "./orbitModel.ts";

/** Pinned at 550 km; the whole profile follows from it and one scale height. */
export const RHO_550_KG_M3 = 2e-12;

/** Exponential scale height through the LEO band these altitudes sit in. */
export const SCALE_HEIGHT_KM = 65;

/** Mass density at an altitude, from the exponential pinned at 550 km. */
export function densityAt(altitudeKm: number, rho550KgM3 = RHO_550_KG_M3): number {
  return rho550KgM3 * Math.exp(-(altitudeKm - 550) / SCALE_HEIGHT_KM);
}

/**
 * Along-track separation, in metres, that two satellites accumulate from a
 * difference in ballistic coefficient alone.
 *
 * `ȧ = −ρ B √(μ a)`, so a difference `ΔB` opens a semi-major axis difference at
 * `Δȧ = −ρ ΔB √(μ a)`. A semi-major axis difference is a mean-motion difference,
 * `Δn = (3/2)(n/a)Δa`, and that is an along-track rate. `Δa` grows linearly in t
 * and the drift is its integral, so:
 *
 *   Δs = (3/4) · n · ρ ΔB √(μ a) · t²
 *
 * The **t²** is the thing to carry away. Every other effect in the cluster model
 * is a rate — a constant number of degrees per day — and this is the one whose
 * growth is itself a growth. It is why a configuration can hold for ten orbits
 * and be gone by thirty.
 *
 * `deltaB` is in m²/kg; `seconds` is the elapsed time.
 */
export function differentialDragDriftM(altitudeKm: number, deltaB: number, seconds: number, rho550KgM3 = RHO_550_KG_M3): number {
  const a = circularSemiMajorAxisKm(altitudeKm) * 1000;
  const mu = WGS72_MU_KM3_S2 * 1e9;
  const n = Math.sqrt(mu / (a * a * a));
  const axisRate = densityAt(altitudeKm, rho550KgM3) * deltaB * Math.sqrt(mu * a);
  return 0.75 * n * axisRate * seconds * seconds;
}

/**
 * The ballistic coefficient `C_d·A/m` of a satellite, from its area-to-mass
 * ratio. `C_d` is near 2.2 for a free-molecular-flow satellite.
 */
export function ballisticCoefficient(areaToMassM2PerKg: number, dragCoefficient = 2.2): number {
  return dragCoefficient * areaToMassM2PerKg;
}

/** The Earth's radius, re-exported so a caller computing an arc need not reach for it. */
export { WGS72_EARTH_RADIUS_KM };

/** Arc length of `degrees` of along-track phase at this altitude, in metres. */
export function arcLengthM(altitudeKm: number, degrees: number): number {
  return circularSemiMajorAxisKm(altitudeKm) * 1000 * ((degrees * Math.PI) / 180);
}

// Orbit design: which parameters move the energy picture, by how much, and what the
// best achievable is.
//
// ./energyStatistics.ts answers "what does *this* orbit do" by propagating it.
// This file answers "what would a *different* orbit do" without propagating anything,
// because the quantity that decides an orbit's energy profile is one angle:
//
//   β — the sun's elevation above the orbit plane.
//
// An orbit is eclipse-free exactly when |β| ≥ arcsin(Rₑ/(Rₑ+h)), and eclipsed for
// roughly a third of every revolution when β is small. So the whole design question
// collapses to: what β can a plane reach, and what β does its altitude demand? Both
// sides are closed form, which is what makes a sweep over hundreds of (h, i) pairs a
// millisecond rather than an afternoon of SGP4.
//
// Cesium-free. The propagated statistics remain the source of truth for any single
// orbit — this is the map, not the territory, and the report cross-checks a few points
// of it against `orbitEnergyProfile`.

import { eclipseFreeBetaDeg, SUN_MAX_DECLINATION_DEG } from "./sunSynchronous";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS_KM = 6378.135;

/**
 * The sun's elevation above an orbit plane, in degrees.
 *
 *   sin β = sin i · cos δ☉ · sin(Ω − α☉) + cos i · sin δ☉
 *
 * Three inputs and no propagation: the inclination, where the ascending node sits
 * relative to the sun in right ascension, and the sun's declination. `nodeSunAngleDeg`
 * is the lever a designer actually has — 90° is dawn–dusk, 0° is noon–midnight — and
 * it is the same number a pattern carries as `raanOffsetDeg` once the sun's position at
 * epoch is subtracted.
 */
export function betaDeg(inclinationDeg: number, nodeSunAngleDeg: number, sunDeclinationDeg: number): number {
  const i = inclinationDeg * DEG_TO_RAD;
  const node = nodeSunAngleDeg * DEG_TO_RAD;
  const declination = sunDeclinationDeg * DEG_TO_RAD;
  const sine = Math.sin(i) * Math.cos(declination) * Math.sin(node) + Math.cos(i) * Math.sin(declination);
  return Math.asin(Math.max(-1, Math.min(1, sine))) * RAD_TO_DEG;
}

/** How many node-phase samples a fraction is measured over. 0.5° steps. */
const NODE_SAMPLES = 720;

/** How many points of the year an annual average is taken over. Ten-day steps. */
const YEAR_SAMPLES = 37;

/**
 * The share of a shell's planes that are eclipse-free at one moment.
 *
 * The design number this module exists for. Planes of a Walker shell are spread evenly
 * over 360° of right ascension, so "what fraction of node phases clears the shadow" and
 * "what fraction of my planes is in sunlight" are the same question — and the answer
 * depends on nothing but the altitude, the inclination and the date.
 *
 * That is the fact a router can act on: it is not a property of a satellite or of an
 * instant, it is a property of the shell's *design*, and it is knowable before launch.
 */
export function eclipseFreePlaneFraction(altitudeKm: number, inclinationDeg: number, sunDeclinationDeg: number): number {
  const required = eclipseFreeBetaDeg(altitudeKm);
  let clear = 0;
  for (let sample = 0; sample < NODE_SAMPLES; sample += 1) {
    const nodeSunAngleDeg = (sample * 360) / NODE_SAMPLES;
    if (Math.abs(betaDeg(inclinationDeg, nodeSunAngleDeg, sunDeclinationDeg)) >= required) {
      clear += 1;
    }
  }
  return clear / NODE_SAMPLES;
}

/**
 * The same, averaged over a year.
 *
 * The sun's declination is sampled through `asin(sin ε · sin λ)` at even steps of
 * ecliptic longitude λ, which is where the declination actually spends its time — an
 * even sweep of *declination* would overweight the solstices, where it lingers, and
 * report a rosier average than the year delivers.
 */
export function annualEclipseFreePlaneFraction(altitudeKm: number, inclinationDeg: number): number {
  let total = 0;
  for (let sample = 0; sample < YEAR_SAMPLES; sample += 1) {
    const eclipticLongitude = (sample * 360) / YEAR_SAMPLES;
    const declination = Math.asin(Math.sin(SUN_MAX_DECLINATION_DEG * DEG_TO_RAD) * Math.sin(eclipticLongitude * DEG_TO_RAD)) * RAD_TO_DEG;
    total += eclipseFreePlaneFraction(altitudeKm, inclinationDeg, declination);
  }
  return total / YEAR_SAMPLES;
}

/**
 * The largest |β| any plane at this inclination can reach at any time of year.
 *
 * `i + 23.44°` folded back through the sine, which means an inclination between 66.56°
 * and 113.44° can put the sun exactly on its orbit normal on one day of the year and
 * reach 90°. Below 66.56° the ceiling is `i + 23.44°` and no orientation beats it.
 */
export function maxReachableBetaDeg(inclinationDeg: number): number {
  const candidates = [-SUN_MAX_DECLINATION_DEG, 0, SUN_MAX_DECLINATION_DEG];
  // The node is free, so the best case is the node that maximises β at each declination.
  return Math.max(...candidates.map((declination) => Math.abs(betaDeg(inclinationDeg, 90, declination))));
}

/**
 * The lowest inclination at which an orbit at this altitude can *ever* be eclipse-free,
 * or undefined when even a 90° plane cannot manage it.
 *
 * Solved by walking inclination upward, because the fold at 66.56° makes the closed
 * form two cases and a monotone scan is one.
 */
export function minInclinationForEclipseFreeDeg(altitudeKm: number): number | undefined {
  const required = eclipseFreeBetaDeg(altitudeKm);
  for (let inclination = 0; inclination <= 90; inclination += 0.05) {
    if (maxReachableBetaDeg(inclination) >= required) {
      return Number(inclination.toFixed(2));
    }
  }
  return undefined;
}

/**
 * How many kilometres of altitude buy the same β margin as one degree of inclination,
 * at this altitude.
 *
 * The exchange rate between the two knobs, and the answer to "which should I spend".
 * One degree of inclination buys one degree of reachable β outright; altitude buys it
 * only through the shrinking shadow, at
 *
 *   dβ_crit/dh = −Rₑ / ((Rₑ+h)² · √(1 − (Rₑ/(Rₑ+h))²))
 *
 * which at 550 km is about 0.02°/km — so a degree of inclination is worth tens of
 * kilometres. It says the two knobs are not interchangeable at the same price, not that
 * either is free: this module knows nothing about launch cost, coverage, latency or
 * radiation dose, and those are what actually decide.
 */
export function betaExchangeRateKmPerDegree(altitudeKm: number): number {
  const semiMajorAxisKm = EARTH_RADIUS_KM + altitudeKm;
  const ratio = EARTH_RADIUS_KM / semiMajorAxisKm;
  const derivativeDegPerKm = (EARTH_RADIUS_KM / (semiMajorAxisKm * semiMajorAxisKm * Math.sqrt(1 - ratio * ratio))) * RAD_TO_DEG;
  return 1 / derivativeDegPerKm;
}

export interface DesignPoint {
  altitudeKm: number;
  inclinationDeg: number;
  /** |β| the shadow demands at this altitude. */
  requiredBetaDeg: number;
  /** The best |β| any plane here can reach, at the best moment of the year. */
  maxBetaDeg: number;
  /** Share of planes eclipse-free right now, at the given declination. */
  planeFractionNow: number;
  /** Share of planes eclipse-free, averaged over a year. */
  planeFractionAnnual: number;
  /** Whether any plane here can ever escape the shadow. */
  everEclipseFree: boolean;
}

/** One cell of the design sweep. */
export function designPoint(altitudeKm: number, inclinationDeg: number, sunDeclinationDeg: number): DesignPoint {
  const requiredBetaDeg = eclipseFreeBetaDeg(altitudeKm);
  const maxBeta = maxReachableBetaDeg(inclinationDeg);
  return {
    altitudeKm,
    inclinationDeg,
    requiredBetaDeg,
    maxBetaDeg: maxBeta,
    planeFractionNow: eclipseFreePlaneFraction(altitudeKm, inclinationDeg, sunDeclinationDeg),
    planeFractionAnnual: annualEclipseFreePlaneFraction(altitudeKm, inclinationDeg),
    everEclipseFree: maxBeta >= requiredBetaDeg,
  };
}

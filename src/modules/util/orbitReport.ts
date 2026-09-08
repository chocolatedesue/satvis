// What one circular orbit does, as data.
//
// The numbers a designer actually reads, assembled in one call — and returned as
// values rather than as a printed report, so a panel, a script and a test can all
// read the same thing. `scripts/research/orbit-lab.ts` is the formatter on top of this;
// `src/components/OrbitLabPanel.vue` reads the same functions piecemeal because it
// wants them live against a form.
//
// Everything here is closed form and Cesium-free. No element set is built and
// nothing is propagated, which is the point: this is what can be said about a
// design *before* it exists — and it is therefore also what can be said about it
// from a terminal, with no build step and no globe.
//
// The caveat that travels with all of it: these are secular J₂ two-body answers
// in WGS-72. Against SGP4 the inclination they name lands within about a tenth of
// a degree and the altitude within a few km; `scripts/research/derive-isl-topology.ts`
// measures exactly that and refines against the propagator, which is the honest
// way round.

import { annualEclipseFreePlaneFraction, maxReachableBetaDeg } from "./orbitDesign.ts";
import { orbitalRates, type CircularOrbit, type OrbitalRates } from "./orbitModel.ts";
import { coPrecessingCeilingKm, minSatellitesPerRing } from "./shellLayout.ts";
import { betaCycleDays, eclipseFreeBetaDeg, sunSyncInclinationDeg, SUN_DEG_PER_DAY } from "./sunSynchronous.ts";

/** One circular orbit, read as the answers it gives. */
export interface OrbitReport {
  /** The orbit it was read off. */
  orbit: CircularOrbit;
  /** Period, mean motion and the two secular rates. */
  rates: OrbitalRates;
  /** The inclination that would make this altitude sun-synchronous, if any does. */
  sunSyncInclinationDeg: number | undefined;
  /** The sun's own motion in right ascension, for reading the two against each other. */
  sunDegPerDay: number;
  /**
   * Days before the orbit plane comes back to the same angle to the sun.
   * Infinite for a sun-synchronous orbit, which never leaves it.
   */
  betaCycleDays: number;
  /** |β| a plane at this altitude needs before it can stay out of the Earth's shadow. */
  requiredBetaDeg: number;
  /** The best |β| any plane at this inclination can reach, at the best moment of the year. */
  reachableBetaDeg: number;
  /** Share of node phases — and so of a shell's planes — that are eclipse-free, over a year. */
  eclipseFreePlaneFraction: number;
  /** The highest altitude that can still share this orbit's node rate, in km. */
  coPrecessingCeilingKm: number;
  /** The fewest satellites a plane needs before its intra-plane links clear the Earth. */
  minSatellitesPerRing: number;
}

/**
 * Everything closed form about one circular orbit, in one call.
 *
 * Deliberately flat rather than nested: a caller that wants one number should not
 * have to know which sub-object it lives in, and a caller that wants them all is
 * about to print a table.
 */
export function orbitReport(orbit: CircularOrbit): OrbitReport {
  return {
    orbit,
    rates: orbitalRates(orbit),
    sunSyncInclinationDeg: sunSyncInclinationDeg(orbit.altitudeKm),
    sunDegPerDay: SUN_DEG_PER_DAY,
    betaCycleDays: betaCycleDays(orbit),
    requiredBetaDeg: eclipseFreeBetaDeg(orbit.altitudeKm),
    reachableBetaDeg: maxReachableBetaDeg(orbit.inclinationDeg),
    eclipseFreePlaneFraction: annualEclipseFreePlaneFraction(orbit),
    coPrecessingCeilingKm: coPrecessingCeilingKm(orbit),
    minSatellitesPerRing: minSatellitesPerRing(orbit.altitudeKm),
  };
}

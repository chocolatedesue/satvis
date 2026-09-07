// The orbit model: a circular orbit reduced to the numbers its behaviour depends
// on, and the one place the WGS-72 constants behind them are spelled out.
//
// Cesium-free, zero runtime imports, like the rest of this folder's geometry — so
// the node-env vitest suite exercises it directly and `scripts/` can run it
// through node's own type stripping.
//
// **Imported with the `.ts` extension spelled out**, unlike the rest of `src/`.
// `scripts/derive-isl-topology.ts` loads `./walkerDelta.ts` through node's type
// stripping, which resolves no specifier a bundler would have to — so anything
// reachable from a generator has to carry its own extension, and that is this
// module from here on. The cost is one unusual specifier per importer; the
// alternative is a generator that cannot be run outside a bundler at all.
//
// ---------------------------------------------------------------------------
// What this is, and what it is not
// ---------------------------------------------------------------------------
//
// An orbit in this app has two faces, and only one of them lives here.
//
// - **A propagatable orbit** is a GP element set — `GpRecord`, built by
//   `./gp.ts` from CelesTrak OMM or TLE text — turned into a satrec and flown by
//   SGP4. That is the contract the whole app already agrees on, and it is
//   complete: a `GpRecord` answers "where is it" to the metre.
// - **A designed orbit** is the same thing *before* it is an element set: an
//   altitude, an inclination, and optionally where the ascending node sits. It
//   cannot be propagated, because it has no epoch and no drag — and it does not
//   need to be, because what is asked of it is a closed form. `Ω̇`, `u̇`, the
//   period, `β`: every one of them is a function of those two numbers alone, and
//   every one of them is the thing a constellation is actually designed against.
//
// `CircularOrbit` is the second of those. It is deliberately **not** a union with
// `GpRecord`: the two are told apart by what they can do, and folding them into
// one type would push that discrimination into `Orbit` and `SampledTrajectory`,
// which each only ever want one arm. What they share is the *shape* of the
// design-time parameters, and that is what is unified here — every generator
// takes an `altitudeKm` and an `inclinationDeg` in the same two field names, so
// a shell, a Walker pattern's orbit, a cluster's orbit and a design sweep cell
// are interchangeable at the call site.
//
// ---------------------------------------------------------------------------
// Why the rates are closed form, and what that buys
// ---------------------------------------------------------------------------
//
// Both secular rates of a circular orbit are one line each — `Ω̇` in
// `./shellLayout.ts`, `β` in `./orbitDesign.ts` — and neither needs a satrec. So
// a design question can be answered for hundreds of candidate orbits in the time
// one SGP4 initialisation takes, and the answer is a *property of the design*
// rather than of a date. `./sunSynchronous.ts` inverts one of them and
// `./shellLayout.ts` matches them across shells; both read the same two numbers
// this type carries.
//
// The cost is that these are two-body answers. A generated pattern flies a few
// kilometres off the altitude it was quoted at, because SGP4 recovers a
// semi-major axis from a Kozai mean motion with the J₂ term in it. That gap is a
// documented property of every generator here, not a bug to be closed.

import type { SatRec } from "satellite.js";

/** WGS-72, matching `./walkerDelta.ts` and therefore SGP4's own recovered elements. */
export const WGS72_EARTH_RADIUS_KM = 6378.135;

/** km³/s². The same system as the radius: SGP4's, not the one a textbook quotes. */
export const WGS72_MU_KM3_S2 = 398600.8;

/** The Earth's oblateness, as SGP4 carries it. What makes an orbit plane precess at all. */
export const WGS72_J2 = 0.001082616;

/**
 * A circular orbit, in the two numbers its behaviour depends on.
 *
 * Every closed form in this folder — the period, the mean motion, the node rate,
 * the along-track rate, the sun's elevation above the plane — is a function of
 * these two and of nothing else. An elliptical orbit would need a third; nothing
 * here generates one, and a formation says its eccentricity in metres rather
 * than as an element (`./clusterFormation.ts`).
 */
export interface CircularOrbit {
  altitudeKm: number;
  inclinationDeg: number;
}

/**
 * A circular orbit that also knows where its ascending node sits, in absolute
 * right ascension.
 *
 * Optional, and load-bearing only once the sun is in the picture: a
 * sun-synchronous plane at 06:00 local time and the same plane at noon differ by
 * this and by nothing else, and only one of them stays out of the Earth's
 * shadow. A Walker pattern and a cluster both carry it, so both are quoted as
 * one; a shell in `./shellLayout.ts` compares rates, which no rotation of the
 * whole constellation changes, so it does not.
 */
export interface OrientedCircularOrbit extends CircularOrbit {
  raanOffsetDeg?: number;
}

const MINUTES_PER_DAY = 1440;
const SECONDS_PER_DAY = 86400;

/** The semi-major axis of a circular orbit at this altitude — the radius Kepler cares about. */
export function circularSemiMajorAxisKm(altitudeKm: number): number {
  return WGS72_EARTH_RADIUS_KM + altitudeKm;
}

/**
 * Mean motion in revolutions a day for a circular orbit at this altitude — the
 * two-body value.
 *
 * Not the value SGP4 flies. A satrec recovers a semi-major axis from a Kozai
 * mean motion with the J₂ term in it, so the altitude actually flown is a few
 * kilometres off the one asked for — around 6 km at 550 km, checked in the
 * tests. That is inside the band a constellation design is quoted to and far
 * outside anything worth a Newton iteration here; a caller that needs the flown
 * altitude should read it off the satrec's apsides, as the info panel already
 * does.
 *
 * Which is the whole reason this exists separately from `propagatedPeriodMinutes`:
 * it needs no satrec, so it answers for a design that has not been generated yet.
 */
export function circularMeanMotionRevPerDay(altitudeKm: number): number {
  const semiMajorAxisKm = circularSemiMajorAxisKm(altitudeKm);
  const radiansPerSecond = Math.sqrt(WGS72_MU_KM3_S2 / (semiMajorAxisKm * semiMajorAxisKm * semiMajorAxisKm));
  return (radiansPerSecond * SECONDS_PER_DAY) / (2 * Math.PI);
}

/**
 * The orbital period in minutes, for a circular orbit at this altitude.
 *
 * Only `altitudeKm` is read — the period does not know about the inclination —
 * but the parameter is the whole orbit, because every caller holds one and
 * naming it altitude here would invite the caller to forget that the two travel
 * together.
 */
export function circularPeriodMinutes(orbit: CircularOrbit): number {
  return MINUTES_PER_DAY / circularMeanMotionRevPerDay(orbit.altitudeKm);
}

/**
 * The four numbers a circular orbit's own motion reduces to.
 *
 * The first two say how fast it goes round; the last two are the **secular J₂**
 * rates that decide how it moves relative to any other orbit, and they are the
 * whole of what `./shellLayout.ts` reasons about:
 *
 *   - `nodeRateDegPerDay` — Ω̇, how fast the J₂ bulge turns the orbit plane. Two
 *     orbits keep a fixed relative plane arrangement exactly when this agrees.
 *   - `alongTrackRateDegPerDay` — u̇, how fast a satellite runs round its own
 *     orbit measured from the ascending node. Two orbits return to the same
 *     relative phase exactly when the *ratio* of these is rational.
 *
 * Both are closed form, so this needs no satrec and no propagation: it is a
 * property of the design, knowable before anything is generated.
 */
export interface OrbitalRates {
  /** Revolutions a day, the two-body value the generators state. */
  meanMotionRevPerDay: number;
  /** Orbital period in minutes, the Keplerian one. */
  periodMinutes: number;
  /** Ω̇ in degrees a day: negative for a prograde orbit, positive for a retrograde one. */
  nodeRateDegPerDay: number;
  /**
   * u̇ in degrees a day: how fast the satellite runs round its own orbit,
   * measured from the ascending node.
   *
   * Not quite 360°/period: J₂ moves the node the satellite is measured from and
   * the perigee it is measured to, and the along-track rate is what is left when
   * both are folded in — `ṁ + ω̇`, which for a circular orbit is the whole of the
   * motion that matters. The correction is a part in a thousand, which is
   * invisible in one orbit and a degree of phase after a hundred.
   */
  alongTrackRateDegPerDay: number;
}

/**
 * The two secular rates of a circular orbit, plus the period they come from.
 *
 * `Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i` — the same expression `./sunSynchronous.ts`
 * inverts for the sun-synchronous inclination, and the one `./shellLayout.ts`
 * matches between two shells. One implementation, so the three agree by
 * construction rather than by a test noticing when they stop.
 */
export function orbitalRates(orbit: CircularOrbit): OrbitalRates {
  const { altitudeKm, inclinationDeg } = orbit;
  const revPerDay = circularMeanMotionRevPerDay(altitudeKm);
  const axisRatioSquared = (WGS72_EARTH_RADIUS_KM / circularSemiMajorAxisKm(altitudeKm)) ** 2;
  const cosine = Math.cos((inclinationDeg * Math.PI) / 180);
  const degPerDay = revPerDay * 360;
  return {
    meanMotionRevPerDay: revPerDay,
    periodMinutes: MINUTES_PER_DAY / revPerDay,
    nodeRateDegPerDay: -1.5 * WGS72_J2 * degPerDay * axisRatioSquared * cosine,
    alongTrackRateDegPerDay: degPerDay * (1 + WGS72_J2 * axisRatioSquared * (6 * cosine * cosine - 1.5)),
  };
}

/**
 * The orbital period in minutes, from the mean motion SGP4 actually recovered.
 *
 * The propagated counterpart of `circularPeriodMinutes`, and about a second off
 * it for the same altitude — measured at 0.96 s median across the live catalog.
 * Anything that places samples in time has to use this one: the sampler derives
 * its grid from the satrec's own mean motion, and a window sized from the
 * two-body value would drift off that grid within a few revolutions.
 *
 * Deliberately unguarded. A satrec SGP4 refused carries `no = 0` or NaN, and
 * this returns Infinity or NaN for it rather than a number that looks like a
 * period — the same value `Orbit.orbitalPeriod` has always returned, and what
 * `./trajectoryWindow.ts` and the pass predictors already treat as "no orbit".
 * A caller that needs a guard has the satrec's `error` to read.
 */
export function propagatedPeriodMinutes(satrec: SatRec): number {
  return (2 * Math.PI) / satrec.no;
}

/** Normalize into [0, 360). Shared by every generator that writes an angle into an element set. */
export function wrapDegrees360(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** What to tell the user when a node offset is out of range. One sentence, as the forms show it. */
export const RAAN_OFFSET_RANGE_ERROR = "RAAN offset must be at least 0° and below 360°.";

/**
 * The complaint about an out-of-range node offset, or undefined when it is in
 * range or was never given.
 *
 * Shared rather than restated because the range is a fact about right ascension,
 * not about the generator: a Walker pattern and a cluster have different things
 * to say about altitude and about their own shape, and exactly the same thing to
 * say about this.
 */
export function raanOffsetError(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0 || value >= 360) {
    return RAAN_OFFSET_RANGE_ERROR;
  }
  return undefined;
}

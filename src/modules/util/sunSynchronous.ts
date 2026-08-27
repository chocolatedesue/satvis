// Sun-synchronous orbits, and the question this module exists for: which of them
// never enters the Earth's shadow.
//
// Cesium-free like the rest of this folder, so the node-env vitest suite exercises
// the arithmetic directly. It is the inverse of what ./orbitFacts.ts reports: that
// file reads an element set and says whether it happens to be sun-synchronous, this
// one is handed an altitude and works out the inclination that makes it so.
//
// Every result here is a **secular J₂ two-body** answer, in the same WGS-72 system
// SGP4 works in, so a generated element set and this module agree with each other.
// They are not a mission analysis: no drag, no third-body, no J₃ or higher, no
// station-keeping, and the eclipse condition is a spherical Earth's umbra with no
// atmosphere. The numbers land within a few tenths of a degree of the published
// inclinations, which is what makes them worth quoting; they are not what anyone
// would fly on.

import { jday, sunPos } from "satellite.js";

import type { WalkerDeltaParams } from "./walkerDelta";
import { meanMotionRevPerDay } from "./walkerDelta";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MINUTES_PER_DAY = 1440;

/** WGS-72, matching walkerDelta and therefore SGP4's own recovered elements. */
const EARTH_RADIUS_KM = 6378.135;
const J2 = 0.001082616;

/**
 * The sun's mean motion in right ascension: 360° over a tropical year.
 *
 * A sun-synchronous orbit is one whose nodal regression matches this, which is what
 * holds its local solar time — and therefore its angle to the sun — fixed. Owned
 * here because this module is what inverts the relationship; ./orbitFacts.ts reads
 * it back off a satrec.
 */
export const SUN_DEG_PER_DAY = 360 / 365.2422;

/**
 * The obliquity of the ecliptic: how far the sun's declination swings either way
 * over a year, and therefore how much a fixed orbit plane's angle to the sun swings
 * with it. The reason an orbit can be sunlit in June and eclipsed in December.
 */
export const SUN_MAX_DECLINATION_DEG = 23.4392911;

/**
 * How fast an orbit plane's node turns, in degrees a day — the answer to "is the
 * orbit fixed?".
 *
 * Almost. An orbit plane is fixed in *inertial* space, not in the rotating Earth's:
 * once launched, it does not follow the ground round, which is why an earth-fixed
 * camera makes a stationary orbit look like it is sweeping past. What it does do is
 * precess, slowly, because the Earth is not a sphere — the J₂ bulge torques the plane
 * at
 *
 *   Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i / (1−e²)²
 *
 * which is a few degrees a day in LEO: −5°/day for the ISS, and *exactly* +0.9856°/day
 * for a sun-synchronous orbit, which is the entire trick those orbits are built on.
 * So "fixed" is right to within a rate this function will tell you.
 *
 * The forward direction of `sunSyncInclinationDeg`, and the same formula
 * `./orbitFacts.ts` applies to a satrec — this one takes the numbers a pattern is
 * quoted in, so the panel can report it before anything is generated.
 */
export function nodalPrecessionDegPerDay(altitudeKm: number, inclinationDeg: number, eccentricity = 0): number {
  const semiMajorAxisKm = EARTH_RADIUS_KM + altitudeKm;
  if (!Number.isFinite(altitudeKm) || semiMajorAxisKm <= EARTH_RADIUS_KM || !Number.isFinite(inclinationDeg) || eccentricity < 0 || eccentricity >= 1) {
    return Number.NaN;
  }
  const meanMotionRadPerMinute = (meanMotionRevPerDay(altitudeKm) * 2 * Math.PI) / MINUTES_PER_DAY;
  const axisRatio = semiMajorAxisKm / EARTH_RADIUS_KM;
  const oneMinusESquared = 1 - eccentricity * eccentricity;
  const ratePerMinute = (-1.5 * J2 * meanMotionRadPerMinute * Math.cos(inclinationDeg * DEG_TO_RAD)) / (axisRatio * axisRatio * oneMinusESquared * oneMinusESquared);
  return ratePerMinute * RAD_TO_DEG * MINUTES_PER_DAY;
}

/**
 * The inclination that makes a circular orbit at this altitude sun-synchronous.
 *
 * Inverts the secular nodal precession
 *
 *   Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i / (1−e²)²
 *
 * for `i`, setting Ω̇ to the sun's own rate. Only a retrograde inclination turns the
 * node the right way, so the answer is always above 90°.
 *
 * Undefined when no inclination satisfies it — above roughly 5975 km the required
 * `cos i` passes −1 and the orbit cannot be made to keep up with the sun at all,
 * which is a real limit and not a failure to converge.
 */
export function sunSyncInclinationDeg(altitudeKm: number, eccentricity = 0): number | undefined {
  const semiMajorAxisKm = EARTH_RADIUS_KM + altitudeKm;
  if (!Number.isFinite(altitudeKm) || semiMajorAxisKm <= EARTH_RADIUS_KM || eccentricity < 0 || eccentricity >= 1) {
    return undefined;
  }
  const meanMotionRadPerMinute = (meanMotionRevPerDay(altitudeKm) * 2 * Math.PI) / MINUTES_PER_DAY;
  const targetRadPerMinute = (SUN_DEG_PER_DAY * DEG_TO_RAD) / MINUTES_PER_DAY;
  const axisRatio = semiMajorAxisKm / EARTH_RADIUS_KM;
  const oneMinusESquared = 1 - eccentricity * eccentricity;
  const cosine = -(targetRadPerMinute * axisRatio * axisRatio * oneMinusESquared * oneMinusESquared) / (1.5 * J2 * meanMotionRadPerMinute);
  if (cosine < -1 || cosine > 1) {
    return undefined;
  }
  return Math.acos(cosine) * RAD_TO_DEG;
}

/**
 * The smallest |β| at which a circular orbit at this altitude clears the Earth's
 * shadow: `arcsin(Rₑ / (Rₑ + h))`.
 *
 * β is the sun's elevation above the orbit plane, so this is the half-angle the
 * Earth subtends from the orbit — tilt the plane further than that out of the
 * sun-Earth line and the shadow cylinder misses it entirely. Higher orbits need
 * less tilt, which is the whole reason altitude buys sunlight.
 *
 * The *umbral* condition, on a spherical Earth with no atmosphere. The viewer's own
 * ν uses a conical model with a penumbra, so an orbit sitting exactly on this
 * boundary will still show a penumbra sliver — which is why `ALWAYS_SUNLIT_MARGIN_DEG`
 * exists.
 */
export function eclipseFreeBetaDeg(altitudeKm: number): number {
  return Math.asin(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm)) * RAD_TO_DEG;
}

/**
 * How much β to ask for beyond the umbral boundary before calling an orbit
 * always-sunlit.
 *
 * One degree covers the penumbra the viewer's conical shadow model reports either
 * side of the geometric edge, plus the tenths of a degree this module's secular
 * inclination differs from what SGP4 recovers. Without it the "always sunlit"
 * altitude comes out about 20 km too low and the demo shows the one thing it claims
 * cannot happen.
 */
export const ALWAYS_SUNLIT_MARGIN_DEG = 1;

/**
 * The angle between the sun and the orbit plane for a **dawn–dusk** plane, at a
 * given solar declination.
 *
 * Dawn–dusk means the ascending node is held 90° from the sun in right ascension,
 * which is the orientation that puts the sun as near the orbit normal as the
 * inclination allows — and so the orientation that maximises β. Then
 *
 *   sin β = sin(i + δ☉)
 *
 * which for a retrograde i is a β that falls as the sun moves north and rises as it
 * moves south. Six months apart the same orbit is at its best and its worst.
 */
export function dawnDuskBetaDeg(inclinationDeg: number, sunDeclinationDeg: number): number {
  const sine = Math.sin((inclinationDeg + sunDeclinationDeg) * DEG_TO_RAD);
  return Math.asin(Math.max(-1, Math.min(1, sine))) * RAD_TO_DEG;
}

/** The β a dawn–dusk plane at this inclination sees at the two solstices and between. */
export function dawnDuskBetaRangeDeg(inclinationDeg: number): { minDeg: number; maxDeg: number } {
  const candidates = [-SUN_MAX_DECLINATION_DEG, 0, SUN_MAX_DECLINATION_DEG].map((declination) => Math.abs(dawnDuskBetaDeg(inclinationDeg, declination)));
  return { minDeg: Math.min(...candidates), maxDeg: Math.max(...candidates) };
}

export interface AlwaysSunlitVerdict {
  /** The sun-synchronous inclination at this altitude, or undefined if there is none. */
  inclinationDeg: number | undefined;
  /** |β| at the worst moment of the year, for a dawn–dusk plane. */
  worstBetaDeg: number;
  /** What |β| has to clear, umbra plus margin. */
  requiredBetaDeg: number;
  /** Whether the orbit is out of the Earth's shadow for the whole year. */
  alwaysSunlit: boolean;
}

/**
 * Whether a dawn–dusk sun-synchronous orbit at this altitude is sunlit all year,
 * and the two numbers the answer is a comparison of.
 */
export function alwaysSunlitVerdict(altitudeKm: number): AlwaysSunlitVerdict {
  const inclinationDeg = sunSyncInclinationDeg(altitudeKm);
  const requiredBetaDeg = eclipseFreeBetaDeg(altitudeKm) + ALWAYS_SUNLIT_MARGIN_DEG;
  if (inclinationDeg === undefined) {
    return { inclinationDeg, worstBetaDeg: Number.NaN, requiredBetaDeg, alwaysSunlit: false };
  }
  const worstBetaDeg = dawnDuskBetaRangeDeg(inclinationDeg).minDeg;
  return { inclinationDeg, worstBetaDeg, requiredBetaDeg, alwaysSunlit: worstBetaDeg >= requiredBetaDeg };
}

/** The altitudes over which a dawn–dusk sun-synchronous orbit is sunlit all year. */
export interface AlwaysSunlitBand {
  lowestKm: number;
  highestKm: number;
}

/**
 * The band of altitudes where a dawn–dusk sun-synchronous orbit never enters the
 * Earth's shadow — and it is a band, not a floor.
 *
 * Two curves are being compared, and both fall with altitude. The shadow's
 * half-angle `arcsin(Rₑ/(Rₑ+h))` falls because the Earth subtends less; the β a
 * dawn–dusk plane can reach falls because sun-synchrony demands an ever steeper
 * retrograde inclination as the orbit rises, and β is capped by `180° − i − 23.44°`.
 * Below the band the shadow is still too big; above it the inclination has run away
 * — at 5000 km sun-synchrony wants i ≈ 139°, which leaves β under 20° against a
 * required 35°. So they cross twice.
 *
 * That is the answer worth taking away, and it is not where intuition puts it: no
 * flown dawn–dusk mission is inside the band. Sentinel-1 at 693 km and TerraSAR-X at
 * 514 km are both far below it, and are eclipse-free for part of the year rather than
 * all of it.
 *
 * Scan then bisect: the sign pattern is known to be false-true-false but the
 * crossings are roots of a difference of transcendental functions, so each edge is
 * found by bisection over an interval a coarse scan has bracketed. Rounded outward to
 * 10 km, which is the precision a secular model deserves. Undefined if no altitude
 * qualifies at all.
 */
export function alwaysSunlitAltitudeBandKm(): AlwaysSunlitBand | undefined {
  const STEP_KM = 25;
  const LOWEST_SEARCHED_KM = 200;
  const HIGHEST_SEARCHED_KM = 6000;

  let firstInside: number | undefined;
  let lastInside: number | undefined;
  for (let altitude = LOWEST_SEARCHED_KM; altitude <= HIGHEST_SEARCHED_KM; altitude += STEP_KM) {
    if (alwaysSunlitVerdict(altitude).alwaysSunlit) {
      firstInside ??= altitude;
      lastInside = altitude;
    }
  }
  if (firstInside === undefined || lastInside === undefined) {
    return undefined;
  }
  const lowestKm = bisectEdge(firstInside - STEP_KM, firstInside);
  const highestKm = bisectEdge(lastInside + STEP_KM, lastInside);
  return { lowestKm: Math.ceil(lowestKm / 10) * 10, highestKm: Math.floor(highestKm / 10) * 10 };
}

/** The altitude where the verdict flips between `outside` and `inside`. */
function bisectEdge(outside: number, inside: number): number {
  let low = outside;
  let high = inside;
  for (let step = 0; step < 40; step += 1) {
    const middle = (low + high) / 2;
    if (alwaysSunlitVerdict(middle).alwaysSunlit) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

/**
 * One altitude inside the band, for a demo that wants a single number.
 *
 * The lower edge plus a tenth of the band's width: near the bottom, because that is
 * the interesting end — the lowest orbit that gets永久 sunlight — and not *on* it,
 * because an orbit sitting exactly on a boundary is a demo of the boundary's
 * tolerance rather than of the effect.
 */
export function representativeAlwaysSunlitAltitudeKm(): number | undefined {
  const band = alwaysSunlitAltitudeBandKm();
  if (!band) {
    return undefined;
  }
  return Math.round((band.lowestKm + (band.highestKm - band.lowestKm) / 10) / 10) * 10;
}

/** The sun's right ascension in degrees, from satellite.js's own low-precision model. */
export function sunRightAscensionDeg(date: Date): number {
  return wrapDegrees(sunPos(jday(date)).rtasc * RAD_TO_DEG);
}

/**
 * Which way the orbit plane faces relative to the sun.
 *
 * Not a local time, though it decides one: what the geometry cares about is the
 * angle between the ascending node and the sun in right ascension, and these are the
 * two values worth generating. `dawn-dusk` puts the node 90° from the sun, along the
 * terminator, which maximises β and is the only orientation that can be
 * always-sunlit. `noon-midnight` puts it on the sun-Earth line, which minimises β
 * and gives the deepest eclipses — the same orbit, turned a quarter turn.
 */
export type SsoPlane = "dawn-dusk" | "noon-midnight";

/** The right ascension of the ascending node this plane wants, at this instant. */
export function ssoRaanDeg(plane: SsoPlane, date: Date): number {
  return wrapDegrees(sunRightAscensionDeg(date) + (plane === "dawn-dusk" ? 90 : 0));
}

export interface SsoRequest {
  altitudeKm: number;
  /** Total satellites. Spread round one plane unless `planes` says otherwise. */
  total: number;
  planes?: number;
  phasing?: number;
  plane: SsoPlane;
}

/**
 * A sun-synchronous constellation as a Walker pattern, with the inclination computed
 * and the node placed relative to the sun.
 *
 * Undefined when no inclination is sun-synchronous at that altitude. The epoch is
 * needed because the node is placed relative to where the sun actually is; after
 * that the orbit keeps station on it by construction, which is what
 * sun-synchronous means.
 */
export function sunSyncWalkerParams(request: SsoRequest, epoch: Date): WalkerDeltaParams | undefined {
  const inclinationDeg = sunSyncInclinationDeg(request.altitudeKm);
  if (inclinationDeg === undefined) {
    return undefined;
  }
  return {
    total: request.total,
    planes: request.planes ?? 1,
    phasing: request.phasing ?? 0,
    inclinationDeg: Number(inclinationDeg.toFixed(3)),
    altitudeKm: request.altitudeKm,
    raanSpanDeg: 360,
    raanOffsetDeg: Number(ssoRaanDeg(request.plane, epoch).toFixed(3)),
  };
}

function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

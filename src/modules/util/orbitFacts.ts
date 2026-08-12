// Facts about the orbit that follow from the element set rather than being served
// with it. Same standing as `orbitClass`. Shown beside it, not in the raw element
// table.
//
// Cesium-free on purpose: this is arithmetic over a satrec, so the node-env vitest
// suite exercises it directly. `getSatelliteInfo` in ./entityInfo.ts is the only
// caller, and composes these rows with the served ones.

import { constants, gstime, type SatRec } from "satellite.js";

import type Orbit from "../Orbit";

const RAD_TO_DEG = 180 / Math.PI;
const HOURS_PER_DEGREE = 24 / 360;
const MINUTES_PER_DAY = 1440;

/**
 * The sun's mean motion in right ascension: 360° over a tropical year. A sun-
 * synchronous orbit is one whose nodal regression matches this, which is what
 * holds its local solar time fixed.
 */
const SUN_DEG_PER_DAY = 360 / 365.2422;

/**
 * How far off that rate still counts as sun-synchronous, in °/day.
 *
 * 0.05°/day is about 12 minutes of local-time drift per month. Loose enough to keep
 * a satellite that is sun-synchronous by design but no longer station-kept: TERRA
 * has drifted ~1 h 45 m since its altitude stopped being maintained, a mismatch of
 * ~0.014°/day. Tight enough to be a ±0.5° window in inclination, which nothing
 * lands in by accident.
 */
const SUN_SYNC_TOLERANCE_DEG_PER_DAY = 0.05;

/**
 * Nodal regression from Earth's oblateness, in °/day:
 *
 *   Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i / (1−e²)²
 *
 * Prograde orbits give a negative rate and so can never be sun-synchronous; only
 * a retrograde inclination turns the node the right way. Reads the SGP4-recovered
 * mean motion and semi-major axis, so it agrees with the apsides above rather than
 * with the raw Kozai elements.
 */
function nodalPrecessionDegPerDay(satrec: SatRec): number {
  const { no, a, ecco, inclo } = satrec;
  if (!Number.isFinite(no) || !Number.isFinite(a) || a <= 0) {
    return Number.NaN;
  }
  const oneMinusESquared = 1 - ecco * ecco;
  const ratePerMinute = (-1.5 * constants.j2 * no * Math.cos(inclo)) / (a * a * oneMinusESquared * oneMinusESquared);
  return ratePerMinute * RAD_TO_DEG * MINUTES_PER_DAY;
}

/**
 * Whether the orbit plane keeps pace with the sun.
 *
 * Deliberately not a fifth value of `OrbitClass`. That enum is an altitude and
 * period regime; this is the plane's relationship to the sun, and the two are
 * independent — every sun-synchronous satellite is also in LEO. Folding "SSO" into
 * the enum would force a satellite to be one or the other. And `isLeo` in
 * satelliteGraphics.ts is exactly `orbitClass === "LEO"`. Reclassifying Sentinel-2
 * would silently strip the ground track and sensor cone from the very satellites
 * those visuals exist for. It would also take a large bite out of the
 * neutral-coloured majority that ORBIT_CLASS_COLOR is built around.
 */
export function isSunSynchronous(satrec: SatRec): boolean {
  const rate = nodalPrecessionDegPerDay(satrec);
  return Number.isFinite(rate) && Math.abs(rate - SUN_DEG_PER_DAY) <= SUN_SYNC_TOLERANCE_DEG_PER_DAY;
}

/**
 * Apogee and perigee altitudes in km above the equatorial radius SGP4 works in, as
 * one `high / low km` row.
 *
 * SGP4 computes both while initialising the satrec: `alta`/`altp`, in Earth radii,
 * from the recovered semi-major axis and the eccentricity. So this is a multiply.
 * They say what the live altitude cannot: whether 415 km is the whole story or one
 * point on an ellipse. ISS reads 424 / 414 km; ARKTIKA-M 1, also just "HEO", reads
 * 39566 / 789 km.
 *
 * One row, because the pair is how an orbit is quoted. The interesting thing is the
 * gap between the two numbers, which two separated rows make you find. Unit stated
 * once, at the end, since both values carry it.
 */
function apsideRows(satrec: SatRec): [string, string][] {
  if (!Number.isFinite(satrec.alta) || !Number.isFinite(satrec.altp)) {
    return [];
  }
  const apogee = (satrec.alta * constants.earthRadius).toFixed(0);
  const perigee = (satrec.altp * constants.earthRadius).toFixed(0);
  return [["Apogee / Perigee", `${apogee} / ${perigee} km`]];
}

/**
 * Local mean solar time at the ascending and descending node crossings, as one
 * `HH:MM / HH:MM` row.
 *
 * This is the number that says what a sun-synchronous satellite is *for*: a 10:30
 * descending node is a morning imager whose scenes have consistent shadows, 13:30
 * ascending is an afternoon one. Neither the inclination nor the period tells you
 * that. Nor can it be read off the position: it is the relationship between the
 * orbit plane and the sun.
 *
 *   LTAN = UT + (Ω − GMST) / 15°/h
 *
 * The bracket is the node's geographic longitude, and UT plus a longitude offset is
 * mean solar time by definition. So this needs no sun ephemeris. And it lands on
 * *mean* solar time, which is what mission specs quote. An apparent-sun derivation
 * would differ by the equation of time, up to ±16 min.
 *
 * Evaluated at the element set's epoch, because that is the instant Ω is given for.
 * That is a standing fact only for a sun-synchronous orbit. There the nodal
 * regression cancels the sun's motion by design and the times hold for months,
 * which is why this is gated on `isSunSynchronous`. Shown for anything else it
 * would be true for a day: the ISS drifts through every local time in about two
 * months.
 *
 * One row rather than two, because the two are always exactly 12 h apart: the
 * descending node is 180° round the plane, so the second is not a second fact. Both
 * still appear, because which one a mission is quoted by depends on which crossing
 * carries its daylight pass.
 */
function nodeCrossingRows(satrec: SatRec): [string, string][] {
  if (!isSunSynchronous(satrec)) {
    return [];
  }
  const jd = satrec.jdsatepoch;
  if (!Number.isFinite(jd)) {
    return [];
  }
  // A Julian day starts at noon, so the half-day offset turns the fraction into UT.
  const utHours = ((((jd + 0.5) % 1) + 1) % 1) * 24;
  const nodeLongitudeDeg = (satrec.nodeo - gstime(jd)) * RAD_TO_DEG;
  const ltan = wrapHours(utHours + nodeLongitudeDeg * HOURS_PER_DEGREE);
  return [["LTAN / LTDN", `${formatHours(ltan)} / ${formatHours(wrapHours(ltan + 12))}`]];
}

/**
 * What to show as the orbit's regime: the derived class, plus the sun-synchronous
 * note when it applies.
 *
 * This is where "SSO" belongs: appended to the class rather than replacing it. A
 * satellite reads "LEO · Sun-synchronous" and stays LEO everywhere that matters.
 * See `isSunSynchronous` for why the enum is left alone.
 */
export function orbitRegimeLabel(orbitClass: string, orbit: Orbit): string {
  if (orbit.error !== 0 || !isSunSynchronous(orbit.satrec)) {
    return orbitClass;
  }
  return `${orbitClass} · Sun-synchronous`;
}

/** Every derived orbit fact, in the order the panel shows them. */
export function derivedOrbitRows(orbit: Orbit): [string, string][] {
  // A satrec SGP4 rejected describes no orbit, so nothing below it is a real number.
  if (orbit.error !== 0) {
    return [];
  }
  return [...apsideRows(orbit.satrec), ...nodeCrossingRows(orbit.satrec)];
}

function wrapHours(hours: number): number {
  return ((hours % 24) + 24) % 24;
}

/** `HH:MM`, rounded to the minute and carrying into the hour. */
function formatHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60) % (24 * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

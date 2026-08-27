// Illumination geometry: the ν (eclipse) and κ (panel) channels behind the
// IlluminationState vocabulary, and the per-satellite cache the globe reads them
// through.
//
// Cesium-free on purpose, like ./orbitFacts.ts: this is arithmetic over a satrec
// and a sun vector, so the node-env vitest suite exercises it directly. The
// callers that do touch Cesium (SatelliteProperties, the orbit-lab panel) convert
// a JulianDate to a Date and stop there.
//
// Where the physics comes from, and what it is worth:
//
// - ν is `1 − shadowFraction`, satellite.js's own conical shadow model (sun and
//   Earth as discs, so umbra *and* penumbra rather than a cylinder). Its sun
//   position is a low-precision model — ~0.01° over 1950–2050 — and the Earth is
//   a sphere. That is well inside what an eclipse boundary cares about, and well
//   outside what a numerical comparison against a dedicated propagator would
//   accept. Treat these numbers as the viewer's own, not as a reference.
// - κ is a *model*, not a measurement: see PanelAxis. Nothing in a GP element set
//   describes attitude.

import { jday, propagate, shadowFraction, sunPos, type EciVec3, type SatRec } from "satellite.js";

import type { IlluminationState, PanelAxis } from "../../config/illumination";

/** Below this much of the solar disc left uncovered, the satellite is in umbra. */
const NU_UMBRA = 1e-3;

/** Above this, no measurable part of the disc is covered and the satellite is in full sun. */
const NU_FULL_SUN = 1 - 1e-3;

/**
 * How near edge-on counts as edge-on: |κ| below this is `sunlit_edge`.
 *
 * 0.1 is ~5.7° off the terminator of the panel's own hemisphere, and about the
 * point below which the cosine loss (>90%) makes the distinction between "a
 * little power" and "none" academic. It also gives the state a visible width on
 * the timeline: with a zenith panel in LEO, κ sweeps through zero in roughly a
 * minute, so a tighter band would render as a colour nobody can see.
 */
const KAPPA_EDGE = 0.1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One satellite's illumination at one instant. */
export interface Illumination {
  /** Fraction of the solar disc *not* covered by the Earth: 0 = umbra, 1 = full sun. */
  nu: number;
  /** Signed cosine between the panel normal and the sun direction. Not clamped. */
  kappa: number;
  state: IlluminationState;
  /** Sun elevation above the orbital plane, in degrees. Signed by the orbit normal. */
  betaDeg: number;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function norm(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

/** Undefined for a zero-length vector, which has no direction to report. */
function unit(v: Vec3): Vec3 | undefined {
  const length = norm(v);
  if (!Number.isFinite(length) || length === 0) {
    return undefined;
  }
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * The sun in the same TEME-ish inertial frame SGP4 reports positions in, both as
 * the AU vector `shadowFraction` wants and as a unit vector for κ.
 *
 * Returned as a pair rather than derived twice: every satellite at a given instant
 * shares this, and it is the only part of the calculation that is not per-satellite.
 */
export interface SunGeometry {
  /** As `sunPos().rsun` — AU, and what `shadowFraction` expects. */
  au: EciVec3<number>;
  unit: Vec3;
}

export function sunGeometry(date: Date): SunGeometry | undefined {
  const { rsun } = sunPos(jday(date));
  const direction = unit(rsun);
  if (!direction) {
    return undefined;
  }
  return { au: rsun, unit: direction };
}

/**
 * The panel normal for one orbital state, under the given model.
 *
 * Undefined when the state does not define the frame — a zero position or a
 * position and velocity that are parallel (which SGP4 does not produce for a real
 * orbit, but a malformed element set can).
 */
export function panelNormal(positionKm: Vec3, velocityKmS: Vec3, axis: PanelAxis): Vec3 | undefined {
  switch (axis) {
    case "zenith":
      return unit(positionKm);
    case "velocity":
      return unit(velocityKmS);
    case "normal":
      return unit(cross(positionKm, velocityKmS));
  }
}

/** Which state a (ν, κ) pair is. The single place the thresholds are applied. */
export function illuminationState(nu: number, kappa: number): IlluminationState {
  if (nu <= NU_UMBRA) {
    return "umbra";
  }
  if (nu < NU_FULL_SUN) {
    return "penumbra";
  }
  if (Math.abs(kappa) <= KAPPA_EDGE) {
    return "sunlit_edge";
  }
  return kappa < 0 ? "sunlit_back" : "sunlit_on";
}

/**
 * ν, κ and the state for one orbital state and one sun direction.
 *
 * Takes the sun already resolved so a whole constellation at one instant pays for
 * it once. Undefined when the geometry is not defined (see `panelNormal`).
 */
export function illuminationOf(positionKm: Vec3, velocityKmS: Vec3, sun: SunGeometry, axis: PanelAxis): Illumination | undefined {
  const normal = panelNormal(positionKm, velocityKmS, axis);
  const orbitNormal = unit(cross(positionKm, velocityKmS));
  if (!normal || !orbitNormal) {
    return undefined;
  }
  const nu = 1 - shadowFraction(sun.au, positionKm);
  const kappa = dot(normal, sun.unit);
  // The sun's elevation above the orbital plane: 90° minus the angle to the
  // plane's own normal, so it is signed the way the normal is and reads 0 for a
  // sun lying in the plane.
  const betaDeg = 90 - (Math.acos(Math.max(-1, Math.min(1, dot(orbitNormal, sun.unit)))) * 180) / Math.PI;
  return { nu, kappa, state: illuminationState(nu, kappa), betaDeg };
}

/**
 * The same, propagating the satrec for the caller. Undefined when SGP4 declines —
 * a decayed or rejected element set has no position, and so no illumination.
 */
export function illuminationAt(satrec: SatRec, date: Date, axis: PanelAxis): Illumination | undefined {
  const sun = sunGeometry(date);
  if (!sun) {
    return undefined;
  }
  const state = propagate(satrec, date);
  if (!state) {
    return undefined;
  }
  return illuminationOf(state.position, state.velocity, sun, axis);
}

/**
 * How long one state's colour is allowed to be reused, in simulation seconds.
 *
 * The point's colour is read once per satellite per frame, and each miss costs an
 * SGP4 propagation plus a sun position. One second of simulated time is under
 * 8 km of LEO travel and cannot move a satellite across an eclipse boundary
 * unnoticed, while at the default 1× playback it collapses sixty reads a second
 * into one. It buys nothing at a 3600× multiplier — there every frame is a new
 * second — which is the honest cost of colouring by a physical quantity rather
 * than by a standing fact.
 */
const CACHE_QUANTUM_SECONDS = 1;

/**
 * One satellite's illumination, memoized on a one-second grid of simulation time.
 *
 * Per satellite rather than shared, because the memo is keyed on time alone: the
 * satellite is the cache. Invalidated by the panel axis changing, which is the
 * one input that is not time.
 */
export class IlluminationCache {
  readonly #satrec: SatRec;

  #axis: PanelAxis;

  #bucket: number | undefined;

  #value: Illumination | undefined;

  constructor(satrec: SatRec, axis: PanelAxis) {
    this.#satrec = satrec;
    this.#axis = axis;
  }

  get axis(): PanelAxis {
    return this.#axis;
  }

  set axis(next: PanelAxis) {
    if (next === this.#axis) {
      return;
    }
    this.#axis = next;
    this.#bucket = undefined;
    this.#value = undefined;
  }

  at(date: Date): Illumination | undefined {
    const bucket = Math.floor(date.getTime() / (CACHE_QUANTUM_SECONDS * 1000));
    if (bucket === this.#bucket) {
      return this.#value;
    }
    this.#bucket = bucket;
    this.#value = illuminationAt(this.#satrec, date, this.#axis);
    return this.#value;
  }
}

/** One point on an illumination timeline. */
export interface IlluminationSample extends Illumination {
  /** Milliseconds since the epoch, so a caller can place it on a ruler without a Date. */
  timeMs: number;
}

export interface IlluminationTimeline {
  samples: IlluminationSample[];
  /** Fraction of the sampled span spent in each state, summing to 1 (or empty). */
  fractions: Partial<Record<IlluminationState, number>>;
  /** Fraction of the span with no usable power: umbra, penumbra or a back-facing panel. */
  darkFraction: number;
}

/**
 * A satellite's illumination over a span, and the share of it each state takes.
 *
 * Uniform sampling rather than boundary solving: what this feeds is a strip of
 * colour and a set of percentages, and at a 10 s step the worst an eclipse
 * boundary can be misplaced is 10 s out of a ~5700 s orbit. Solving for the
 * crossings would be a different function with a different return type.
 *
 * `fractions` counts samples, so it is only a duration ratio because the grid is
 * uniform — stated here because the caller reads it as one.
 */
export function illuminationTimeline(satrec: SatRec, start: Date, durationSeconds: number, stepSeconds: number, axis: PanelAxis): IlluminationTimeline {
  const samples: IlluminationSample[] = [];
  const counts = new Map<IlluminationState, number>();
  const step = Math.max(1, stepSeconds);
  for (let offset = 0; offset <= durationSeconds; offset += step) {
    const date = new Date(start.getTime() + offset * 1000);
    const illumination = illuminationAt(satrec, date, axis);
    if (!illumination) {
      continue;
    }
    samples.push({ ...illumination, timeMs: date.getTime() });
    counts.set(illumination.state, (counts.get(illumination.state) ?? 0) + 1);
  }
  const fractions: Partial<Record<IlluminationState, number>> = {};
  for (const [state, count] of counts) {
    fractions[state] = count / samples.length;
  }
  const dark = (fractions.umbra ?? 0) + (fractions.penumbra ?? 0) + (fractions.sunlit_back ?? 0);
  return { samples, fractions, darkFraction: samples.length === 0 ? 0 : dark };
}

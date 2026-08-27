// Walker Delta constellations as element sets: the pattern in, GP records out.
//
// Cesium-free, like the rest of ./gp.ts's neighbourhood, so the node-env vitest
// suite exercises the geometry directly.
//
// Why OMM and not TLE: a TLE is a fixed-column format with a checksum and a
// two-digit year, and every one of those is a way to generate a constellation
// that parses as something else. The OMM arm of `GpRecord` takes the same numbers
// as named fields, and `json2satrec` is the same seam either way — so the
// generator states inclination in degrees and is done.
//
// What these records are NOT: a prediction about any real constellation. They
// carry no drag term, no J2-corrected mean motion and no epoch offset per plane.
// A Walker pattern is a *geometry*, and this is that geometry expressed in the
// only vocabulary the rest of the app reads.

import type { GpRecord } from "./gp";

/**
 * A Walker Delta pattern, in the notation it is quoted in — `i: T/P/F` — plus the
 * altitude that fixes its period.
 *
 * `phasing` is Walker's F: the along-track offset between adjacent planes, in
 * units of 360°/T. It is what decides whether satellites in neighbouring planes
 * pass each other abreast (F = 0) or interleaved, and so what the inter-plane
 * geometry looks like; it changes nothing about any single orbit.
 */
export interface WalkerDeltaParams {
  /** Total satellites, Walker's T. Must equal planes × satsPerPlane. */
  total: number;
  /** Orbital planes, Walker's P. */
  planes: number;
  /** Phasing factor, Walker's F. Meaningful modulo `planes`. */
  phasing: number;
  inclinationDeg: number;
  altitudeKm: number;
  /**
   * How much right ascension the planes are spread over.
   *
   * 360° is a Walker *Delta* — the planes share the sky evenly. 180° is a Walker
   * *Star*, where every plane crosses at the poles and adjacent planes are
   * counter-rotating in the overlap. Held as a number rather than a "delta | star"
   * flag because it is one, and because a partial span is a real design.
   */
  raanSpanDeg: number;
}

/** Satellites per plane. Derived, never stored: T and P are what the notation gives. */
export function satsPerPlane(params: WalkerDeltaParams): number {
  return Math.round(params.total / params.planes);
}

/**
 * The ceiling on a generated pattern.
 *
 * Not a rendering limit — the globe carries ten thousand real satellites — but a
 * typo limit. The parameters come from a text field and a url, where `10/1/0`
 * becoming `100000/1/0` costs one keystroke, and a generated constellation is
 * built synchronously on the main thread.
 */
export const MAX_WALKER_SATELLITES = 5000;

/** WGS-72 values, so the derived mean motion is in the same system SGP4 works in. */
const EARTH_RADIUS_KM = 6378.135;
const MU_KM3_S2 = 398600.8;
const SECONDS_PER_DAY = 86400;

/**
 * Mean motion in revolutions per day for a circular orbit at this altitude.
 *
 * The two-body value. SGP4 reads MEAN_MOTION as a Kozai mean motion and recovers
 * a semi-major axis from it with the J2 term included, so the altitude it
 * actually flies is a few km off the one asked for — around 6 km at 550 km,
 * checked in the tests. That is inside the band a constellation design is quoted
 * to and far outside anything worth a Newton iteration here; a caller that needs
 * the flown altitude should read it off the satrec's apsides, as the info panel
 * already does.
 */
export function meanMotionRevPerDay(altitudeKm: number): number {
  const a = EARTH_RADIUS_KM + altitudeKm;
  const radiansPerSecond = Math.sqrt(MU_KM3_S2 / (a * a * a));
  return (radiansPerSecond * SECONDS_PER_DAY) / (2 * Math.PI);
}

export interface WalkerValidation {
  ok: boolean;
  /** Present when `ok` is false: what to tell the user, in one sentence. */
  error?: string;
}

/** Whether a pattern is buildable, and why not when it is not. */
export function validateWalkerDelta(params: WalkerDeltaParams): WalkerValidation {
  const { total, planes, phasing, inclinationDeg, altitudeKm, raanSpanDeg } = params;
  if (!Number.isInteger(total) || total < 1) {
    return { ok: false, error: "Total satellites (T) must be a positive integer." };
  }
  if (!Number.isInteger(planes) || planes < 1) {
    return { ok: false, error: "Planes (P) must be a positive integer." };
  }
  if (total % planes !== 0) {
    return { ok: false, error: `T must divide evenly into P: ${total} satellites cannot fill ${planes} planes.` };
  }
  if (!Number.isInteger(phasing) || phasing < 0) {
    return { ok: false, error: "Phasing (F) must be a non-negative integer." };
  }
  if (total > MAX_WALKER_SATELLITES) {
    return { ok: false, error: `T is capped at ${MAX_WALKER_SATELLITES} satellites.` };
  }
  if (!Number.isFinite(inclinationDeg) || inclinationDeg < 0 || inclinationDeg > 180) {
    return { ok: false, error: "Inclination must be between 0° and 180°." };
  }
  // Below ~150 km an orbit is not one; above GEO the pattern is still valid
  // geometry, so only the lower end is refused.
  if (!Number.isFinite(altitudeKm) || altitudeKm < 150) {
    return { ok: false, error: "Altitude must be at least 150 km." };
  }
  if (!Number.isFinite(raanSpanDeg) || raanSpanDeg <= 0 || raanSpanDeg > 360) {
    return { ok: false, error: "RAAN span must be greater than 0° and at most 360°." };
  }
  return { ok: true };
}

/** Normalize into [0, 360). */
function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * The pattern as GP records, one per satellite, all sharing one epoch.
 *
 * Plane p carries RAAN = p · span/P; satellite s within it carries mean anomaly
 * s · 360/S + p · F · 360/T. Circular (e = 0), so the argument of perigee is
 * arbitrary and fixed at 0 — which is also what makes the mean anomaly the
 * along-track position directly.
 *
 * `satnumBase` is above the NORAD catalog's occupied range on purpose: these
 * records live in the same `SatelliteCatalog` as the real ones, keyed by
 * satnum + name, and a generated satellite must not be able to shadow a real one.
 */
export function walkerDeltaRecords(params: WalkerDeltaParams, epoch: Date, namePrefix = "WALKER", satnumBase = 900000): GpRecord[] {
  if (!validateWalkerDelta(params).ok) {
    return [];
  }
  const perPlane = satsPerPlane(params);
  const meanMotion = meanMotionRevPerDay(params.altitudeKm);
  const epochIso = epoch.toISOString();
  const records: GpRecord[] = [];
  for (let plane = 0; plane < params.planes; plane += 1) {
    const raan = wrapDegrees((plane * params.raanSpanDeg) / params.planes);
    for (let slot = 0; slot < perPlane; slot += 1) {
      const meanAnomaly = wrapDegrees((slot * 360) / perPlane + (plane * params.phasing * 360) / params.total);
      const index = plane * perPlane + slot;
      const satnum = satnumBase + index;
      records.push({
        kind: "omm",
        omm: {
          OBJECT_NAME: `${namePrefix} P${String(plane + 1).padStart(2, "0")}-${String(slot + 1).padStart(2, "0")}`,
          OBJECT_ID: `WALKER-${index + 1}`,
          EPOCH: epochIso,
          MEAN_MOTION: meanMotion,
          ECCENTRICITY: 0,
          INCLINATION: params.inclinationDeg,
          RA_OF_ASC_NODE: raan,
          ARG_OF_PERICENTER: 0,
          MEAN_ANOMALY: meanAnomaly,
          EPHEMERIS_TYPE: 0,
          CLASSIFICATION_TYPE: "U",
          NORAD_CAT_ID: satnum,
          ELEMENT_SET_NO: 999,
          REV_AT_EPOCH: 1,
          // No drag: a synthetic pattern is a geometry held still, not a
          // constellation left to decay out of it.
          BSTAR: 0,
          MEAN_MOTION_DOT: 0,
          MEAN_MOTION_DDOT: 0,
        },
      });
    }
  }
  return records;
}

/**
 * The wire form: `i:T/P/F@altKm`, with `~span` appended when the planes do not
 * span the full 360°.
 *
 * Walker's own notation, so a link says what a paper would — `53:1584/72/17@550`
 * is one string a reader already knows how to read, and one url parameter rather
 * than five that can arrive inconsistent with each other.
 */
export function encodeWalker(params: WalkerDeltaParams): string {
  const head = `${trimNumber(params.inclinationDeg)}:${params.total}/${params.planes}/${params.phasing}@${trimNumber(params.altitudeKm)}`;
  return params.raanSpanDeg === 360 ? head : `${head}~${trimNumber(params.raanSpanDeg)}`;
}

/** Undefined for anything that is not a valid pattern, so a bad url is simply no constellation. */
export function decodeWalker(wire: string): WalkerDeltaParams | undefined {
  const match = /^(-?[\d.]+):(\d+)\/(\d+)\/(\d+)@([\d.]+)(?:~([\d.]+))?$/.exec(wire.trim());
  if (!match) {
    return undefined;
  }
  const [, inclination, total, planes, phasing, altitude, span] = match;
  const params: WalkerDeltaParams = {
    inclinationDeg: Number(inclination),
    total: Number(total),
    planes: Number(planes),
    phasing: Number(phasing),
    altitudeKm: Number(altitude),
    raanSpanDeg: span === undefined ? 360 : Number(span),
  };
  return validateWalkerDelta(params).ok ? params : undefined;
}

/** Up to 3 decimals, without a trailing `.000`. */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * The tag a generated constellation is registered under.
 *
 * One tag for all of them: the tag is what a user switches on, and "the pattern I
 * generated" is one thing to switch on however many times it has been changed.
 */
export const WALKER_TAG = "Walker";

/**
 * The epoch every generated pattern is stated at.
 *
 * Fixed rather than "now", so the same url draws the same geometry tomorrow. A
 * Walker pattern is a shape, and an epoch that moved with the clock would make
 * every reload a slightly different one — the planes would have precessed by a
 * different amount before the first frame.
 */
export const WALKER_EPOCH_ISO = "2026-01-01T00:00:00.000Z";

/**
 * The name prefix for a pattern: its own wire form.
 *
 * Long, and unambiguous — two patterns generated in one session must not produce
 * satellites that dedupe into each other, and the catalog's identity is
 * satnum + name. What a reader sees on a row is the pattern that put it there.
 */
export function walkerNamePrefix(params: WalkerDeltaParams): string {
  return `W${encodeWalker(params)}`;
}

/**
 * Where a pattern's satnums start, as a function of the pattern itself.
 *
 * Not a constant, because satnum is an identity and not just a label: the
 * propagation pool keeps one satrec per satnum for the whole session
 * (`laneIndexFor`, see CONTEXT.md), so two patterns sharing satnums would have the
 * second one's satellites flying the first one's orbits. Bands of
 * MAX_WALKER_SATELLITES from 900000 up, chosen by a hash of the wire form, keep
 * them apart without a registry — and stay clear of the NORAD catalog, which is
 * six digits below this.
 *
 * Two patterns can still land in the same band if their hashes collide. That costs
 * the second one its own orbits, so it is worth knowing about; with 90 bands it is
 * not worth a registry to prevent.
 */
export function walkerSatnumBase(params: WalkerDeltaParams): number {
  const wire = encodeWalker(params);
  let hash = 0;
  for (let index = 0; index < wire.length; index += 1) {
    hash = (hash * 31 + wire.charCodeAt(index)) % 90;
  }
  return 900000 + hash * MAX_WALKER_SATELLITES;
}

/**
 * Patterns worth opening with, as the menu offers them.
 *
 * Real designs rather than round numbers, because the point of a preset is to
 * start somewhere a reader can check against something. The first is the smallest
 * pattern that still shows what F does, and the default for "just show me one".
 */
export const WALKER_PRESETS: ReadonlyArray<{ label: string; note: string; params: WalkerDeltaParams }> = [
  {
    label: "Minimal 6/3/1",
    note: "Three planes of two — small enough to watch one satellite at a time.",
    params: { total: 6, planes: 3, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
  },
  {
    label: "Iridium-like 66/6/2",
    note: "Polar Walker Star: 6 planes over 180°, the classic cross-linked design.",
    params: { total: 66, planes: 6, phasing: 2, inclinationDeg: 86.4, altitudeKm: 780, raanSpanDeg: 180 },
  },
  {
    label: "Starlink shell 1 (1584/72/17)",
    note: "The 53° / 550 km shell as a Walker pattern — 72 planes of 22.",
    params: { total: 1584, planes: 72, phasing: 17, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 },
  },
  {
    label: "Starlink shell 4 (720/36/20)",
    note: "The 53.2° / 540 km shell — 36 planes of 20.",
    params: { total: 720, planes: 36, phasing: 20, inclinationDeg: 53.2, altitudeKm: 540, raanSpanDeg: 360 },
  },
  {
    label: "Starlink shell 5 (348/6/58)",
    note: "The 97.6° near-polar shell — 6 planes of 58, sun-synchronous by inclination.",
    params: { total: 348, planes: 6, phasing: 58, inclinationDeg: 97.6, altitudeKm: 560, raanSpanDeg: 360 },
  },
  {
    label: "OneWeb-like 648/18/1",
    note: "Polar Walker Star at 1200 km — 18 planes of 36.",
    params: { total: 648, planes: 18, phasing: 1, inclinationDeg: 87.9, altitudeKm: 1200, raanSpanDeg: 180 },
  },
];

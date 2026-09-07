// Tight free-flying formations as element sets: a lattice in, GP records out.
//
// ./walkerDelta.ts generates a *shell* — up to thousands of satellites spread
// over a sphere, where the smallest separation anyone quotes is hundreds of
// kilometres. This file generates a *cluster*: dozens of satellites inside a
// kilometre, where the quantity worth reading is a hundred metres. The pipeline
// is the same one — GP records into `SatelliteManager.addCustomRecords`, SGP4
// from there on — because what changes is the parameters, not the propagation. A
// Walker pattern simply has no way to say "one hundred metres above", having no
// eccentricity to say it with.
//
// Cesium-free, like the rest of this folder's geometry, so the node-env vitest
// suite exercises it directly.
//
// ---------------------------------------------------------------------------
// What a cluster is: an eccentricity-vector lattice
// ---------------------------------------------------------------------------
//
// The usual way to describe a formation is the Clohessy-Wiltshire frame: put the
// origin on a reference satellite, x radial and y along-track, and give every
// member a relative position and velocity. Bounded motion — the members neither
// escape nor collide — is the condition `ydot0 = -2n x0`, and what it produces is
// an epicycle: each satellite runs a 2:1 ellipse about its own centre once per
// orbit, twice as wide along-track as it is tall.
//
//     x(t) = A sin(nt + phi)
//     y(t) = 2A cos(nt + phi) + y_c
//
// That is a *description*, and integrating it needs an integrator. But the same
// motion has an exact closed form in orbital elements, because a 2:1 epicycle of
// amplitude A about a circular reference is nothing but **a small eccentricity**:
//
//     r = a(1 - e cos M)   =>   radial offset = -a e cos M       amplitude a·e
//     u = omega + nu ~ omega + M + 2e sin M   =>   along-track = 2 a e sin M
//
// which is the 2:1 ellipse, 90 degrees out of phase, with no approximation beyond
// first order in e. So:
//
//     e     = A / a           the epicycle's amplitude, as an element
//     omega                   the epicycle's phase, as an element
//     omega + M               where the epicycle's *centre* sits along-track
//
// Every member shares a, i and RAAN — that is what makes the formation bounded,
// and it is not a choice: equal periods want equal a, and any difference in a
// slides the along-track offset forever (see ./shellLayout.ts, which proves the
// same thing one scale up and calls it "no two distinct shells are rigid").
// **The members differ in e and omega and in nothing else**, and the set of
// (e cos omega, e sin omega) pairs *is* the formation. Hence the name.
//
// This is why no integrator appears below. A cluster is 81 element sets, and
// SGP4 flies them exactly as it flies the real catalog — with J2, which the
// formation survives because every member shares a and i and therefore shares
// omegadot and RAANdot, so the whole lattice precesses as one.
//
// ---------------------------------------------------------------------------
// Why the lattice is 1 : 2 and why that makes the extent circular
// ---------------------------------------------------------------------------
//
// Placing members on a grid `(pitch·i` radial, `alongPitch·j` along-track) with
// the bounded velocity field `xdot0 = (n/2) y0, ydot0 = -2n x0` puts every
// epicycle centre on the reference (`y_c = 0`) and gives amplitude
//
//     A = sqrt(x0^2 + y0^2 / 4)
//
// The `/4` is the epicycle's own 2:1 axis ratio, so an along-track pitch of
// exactly twice the radial one — and only that — makes `A = pitch · sqrt(i²+j²)`.
// The amplitude bound is then a *circle* in lattice index rather than an ellipse,
// which is why the design that keeps `i² + j² <= rings²` is the one that fills
// its bounding ellipse evenly. Google's Suncatcher lattice is 100 m x 200 m for
// this reason, and its 81 members are exactly the integer points of a disc of
// radius 5.
//
// The along-track pitch is therefore not a parameter here. It is dynamics.

import type { GpRecord } from "./gp";
import { raanOffsetError, WGS72_EARTH_RADIUS_KM, wrapDegrees360, type OrientedCircularOrbit } from "./orbitModel.ts";
import { meanMotionRevPerDay, WALKER_EPOCH_ISO } from "./walkerDelta.ts";

/**
 * A free-flying cluster: where it flies, how tightly it is packed, and how far
 * out it goes.
 *
 * Deliberately four numbers rather than a satellite count. A cluster's size is
 * *derived* — the integer points of a disc — because the alternative is a count
 * that does not correspond to any lattice and has to be rounded to one anyway.
 *
 * `altitudeKm`, `inclinationDeg` and `raanOffsetDeg` come from `CircularOrbit` and
 * `OrientedCircularOrbit` rather than being restated: the orbit a cluster flies is
 * the same two numbers a Walker pattern and a shell are made of, so
 * `walkerPatternAt` and `./shellLayout.ts` can hand one straight to it.
 */
export interface ClusterFormationParams extends OrientedCircularOrbit {
  /**
   * The radial lattice pitch, in metres. The along-track pitch is twice this and
   * is not separately settable — see the file header: the 2:1 is the epicycle's
   * own axis ratio, and any other choice makes the extent an ellipse in lattice
   * index rather than a circle.
   */
  pitchM: number;
  /** How many rings out the lattice goes: every `(i, j)` with `i² + j² <= rings²`. */
  rings: number;
}

/** Metres in a kilometre, named because it appears in element arithmetic where a bare 1000 reads as a count. */
const M_PER_KM = 1000;

/**
 * The ceiling on a generated cluster.
 *
 * Lower than `MAX_WALKER_SATELLITES` because a cluster is a thing you look *at*:
 * every member is on screen at once inside a kilometre, and past a couple of
 * thousand points the picture is a disc rather than a formation. `rings` grows
 * the count quadratically, so this is also the typo limit — `rings=50` is one
 * keystroke from `rings=5` and is 7,845 satellites.
 */
export const MAX_CLUSTER_SATELLITES = 2000;

/**
 * The largest eccentricity a member may carry, and so the largest formation.
 *
 * Not a physical limit — an orbit at e = 0.05 is an ordinary orbit — but the
 * limit of what this file *means* by a formation. The along-track mapping is
 * first order in e and its second-order error is `A²/a = e·A`, so one percent is
 * where the drawing stops being of the cluster that was asked for. It also
 * decides the scale range on offer: at 650 km it allows a formation up to
 * ~140 km across, which is the difference between a cluster that is one pixel on
 * a globe and one whose members can be told apart on it.
 */
export const MAX_ECCENTRICITY = 0.01;

/** The eccentricity of the outermost member: the whole formation's size, as an element. */
export function maxEccentricity(params: ClusterFormationParams): number {
  return (params.pitchM * params.rings) / ((WGS72_EARTH_RADIUS_KM + params.altitudeKm) * M_PER_KM);
}

/**
 * The lattice: every integer point of the disc of radius `rings`.
 *
 * Returned as `[i, j]` pairs with `i` radial and `j` along-track, centre first —
 * the reference satellite is `(0, 0)` and callers want it by index, not by
 * search. The rest are in scan order, which is what makes the generated names
 * sort into rows.
 */
export function clusterLattice(rings: number): Array<[number, number]> {
  const points: Array<[number, number]> = [[0, 0]];
  for (let i = -rings; i <= rings; i += 1) {
    for (let j = -rings; j <= rings; j += 1) {
      if ((i !== 0 || j !== 0) && i * i + j * j <= rings * rings) {
        points.push([i, j]);
      }
    }
  }
  return points;
}

/** How many satellites a cluster of this many rings holds. */
export function clusterSize(rings: number): number {
  return clusterLattice(rings).length;
}

/**
 * The cluster's radius: how far the outermost member gets from the reference.
 *
 * `2 · pitch · rings`, because the extreme member reaches an amplitude of
 * `pitch · rings` and an epicycle is twice as wide along-track as it is tall. It
 * is the "R" a formation is quoted at — Suncatcher's 1 km is `2 × 100 m × 5` —
 * and the radial extent is half of it, which is the paper's "±R prograde, ±R/2
 * in altitude".
 */
export function clusterRadiusM(params: ClusterFormationParams): number {
  return 2 * params.pitchM * params.rings;
}

export interface ClusterValidation {
  ok: boolean;
  /** Present when `ok` is false: what to tell the user, in one sentence. */
  error?: string;
}

/** Whether a cluster is buildable, and why not when it is not. */
export function validateClusterFormation(params: ClusterFormationParams): ClusterValidation {
  const { altitudeKm, inclinationDeg, pitchM, rings, raanOffsetDeg } = params;
  if (!Number.isFinite(altitudeKm) || altitudeKm < 150) {
    return { ok: false, error: "Altitude must be at least 150 km." };
  }
  if (!Number.isFinite(inclinationDeg) || inclinationDeg < 0 || inclinationDeg > 180) {
    return { ok: false, error: "Inclination must be between 0° and 180°." };
  }
  if (!Number.isFinite(pitchM) || pitchM <= 0) {
    return { ok: false, error: "Lattice pitch must be greater than 0 m." };
  }
  if (!Number.isInteger(rings) || rings < 0) {
    return { ok: false, error: "Rings must be a non-negative integer." };
  }
  if (clusterSize(rings) > MAX_CLUSTER_SATELLITES) {
    return { ok: false, error: `${clusterSize(rings)} satellites exceeds the ${MAX_CLUSTER_SATELLITES} cap; use fewer rings.` };
  }
  // The radial half of the mapping is exact — `r = a(1 - e cos E)` is not an
  // approximation — but the along-track half is first order in e, and its
  // second-order error is `A²/a`: a metre and a half on a 10 km formation, a
  // kilometre on a 200 km one. `MAX_ECCENTRICITY` is where that reaches a
  // percent of the formation's own size, which is the point past which the
  // drawing stops being of the formation asked for.
  if (maxEccentricity(params) > MAX_ECCENTRICITY) {
    return {
      ok: false,
      error: `Cluster radius exceeds the ${Math.round(2 * MAX_ECCENTRICITY * (WGS72_EARTH_RADIUS_KM + altitudeKm))} km the linear formation model holds at this altitude; reduce pitch or rings.`,
    };
  }
  const raanOffset = raanOffsetError(raanOffsetDeg);
  if (raanOffset !== undefined) {
    return { ok: false, error: raanOffset };
  }
  return { ok: true };
}

const RAD_TO_DEG = 180 / Math.PI;

/**
 * The elements of one lattice member, relative to a reference whose argument of
 * latitude at epoch is `argOfLatitudeDeg`.
 *
 * The whole derivation, in four lines. `phi` is the epicycle phase that puts the
 * member at `(pitch·i` radial, `2·pitch·j` along-track) at epoch; `M = phi + 90°`
 * follows from `radial = -a e cos M` having to equal `+A sin(phi)` at `t = 0`;
 * and `omega` is whatever is left over once the argument of latitude is pinned,
 * which is what holds every epicycle centre on the reference instead of letting
 * the members drift apart along-track.
 *
 * Exported because it is the claim this file makes, and a test that can only
 * reach it through generated records is testing the record format too.
 */
export function latticeMemberElements(
  i: number,
  j: number,
  pitchM: number,
  semiMajorAxisM: number,
  argOfLatitudeDeg = 0,
): { eccentricity: number; argOfPericenterDeg: number; meanAnomalyDeg: number } {
  if (i === 0 && j === 0) {
    return { eccentricity: 0, argOfPericenterDeg: 0, meanAnomalyDeg: wrapDegrees360(argOfLatitudeDeg) };
  }
  const amplitudeM = pitchM * Math.hypot(i, j);
  const phaseDeg = Math.atan2(i, j) * RAD_TO_DEG;
  const meanAnomalyDeg = phaseDeg + 90;
  return {
    eccentricity: amplitudeM / semiMajorAxisM,
    argOfPericenterDeg: wrapDegrees360(argOfLatitudeDeg - meanAnomalyDeg),
    meanAnomalyDeg: wrapDegrees360(meanAnomalyDeg),
  };
}

/**
 * The cluster as GP records, one per member, all sharing one epoch.
 *
 * Sharing the epoch is not tidiness. `sgp4Worker` anchors each satellite's sample
 * grid to its own element set's epoch and steps it at `period/SAMPLES_PER_ORBIT`,
 * and `GridPositionProperty` interpolates between those samples — with an error
 * of a few metres, which is *enormous* next to a hundred-metre separation. Give
 * every member the same epoch and the same MEAN_MOTION and the grids coincide
 * exactly, so that error is common-mode and cancels out of every relative
 * quantity, leaving sub-millimetre differential noise. Stagger the epochs and it
 * does not.
 *
 * Which is also why MEAN_MOTION is stated once and shared rather than derived per
 * member: equal periods are the bounded-motion condition, and here they are
 * equal to the last bit rather than to the last kilometre.
 */
export function clusterFormationRecords(params: ClusterFormationParams, epoch: Date, namePrefix = "CLUSTER", satnumBase = 1400000): GpRecord[] {
  if (!validateClusterFormation(params).ok) {
    return [];
  }
  const semiMajorAxisM = (WGS72_EARTH_RADIUS_KM + params.altitudeKm) * M_PER_KM;
  const meanMotion = meanMotionRevPerDay(params.altitudeKm);
  const epochIso = epoch.toISOString();
  const raan = wrapDegrees360(params.raanOffsetDeg ?? 0);
  return clusterLattice(params.rings).map(([i, j], index) => {
    const { eccentricity, argOfPericenterDeg, meanAnomalyDeg } = latticeMemberElements(i, j, params.pitchM, semiMajorAxisM);
    return {
      kind: "omm",
      omm: {
        OBJECT_NAME: `${namePrefix} ${latticeTag(i, j)}`,
        OBJECT_ID: `CLUSTER-${index + 1}`,
        EPOCH: epochIso,
        MEAN_MOTION: meanMotion,
        ECCENTRICITY: eccentricity,
        INCLINATION: params.inclinationDeg,
        RA_OF_ASC_NODE: raan,
        ARG_OF_PERICENTER: argOfPericenterDeg,
        MEAN_ANOMALY: meanAnomalyDeg,
        EPHEMERIS_TYPE: 0,
        CLASSIFICATION_TYPE: "U",
        NORAD_CAT_ID: satnumBase + index,
        ELEMENT_SET_NO: 999,
        REV_AT_EPOCH: 1,
        // No drag, for the reason a Walker pattern carries none: a formation is a
        // geometry held still, not a fleet left to decay out of it. It matters
        // more here — a differential BSTAR is exactly how a real cluster
        // disperses, and modelling that is a different exercise from drawing the
        // free-fall geometry the design is quoted at.
        BSTAR: 0,
        MEAN_MOTION_DOT: 0,
        MEAN_MOTION_DDOT: 0,
      },
    };
  });
}

/**
 * A member's lattice coordinates as they appear in its name: `L+00+05`.
 *
 * Fixed width and signed so the names sort into lattice rows, and so the label a
 * reader sees on the globe is the two numbers that place the satellite — the
 * cluster's equivalent of a Walker satellite's `P01-07`, and deliberately *not*
 * that shape: `planeSlotOf` must not match it, because a cluster has no planes
 * and `constellationLinks` would otherwise try to wire ring and inter-plane links
 * across a formation where neither means anything.
 */
export function latticeTag(i: number, j: number): string {
  const part = (value: number) => `${value < 0 ? "-" : "+"}${String(Math.abs(value)).padStart(2, "0")}`;
  return `L${part(i)}${part(j)}`;
}

/**
 * The lattice coordinates back out of a generated name, or undefined for a name
 * that carries none.
 *
 * Kept next to the producer for the reason `planeSlotOf` is: one definition of
 * the format, so a change to the naming cannot leave a parser elsewhere quietly
 * matching the old shape.
 */
export function latticeIndexOf(name: string | undefined): { i: number; j: number } | undefined {
  if (!name) {
    return undefined;
  }
  const match = /(?:^|\s)L([+-]\d{2})([+-]\d{2})$/.exec(name);
  return match ? { i: Number(match[1]), j: Number(match[2]) } : undefined;
}

/**
 * The wire form: `i:ringsXpitch@altKm`, with `+offset` when the node is not at 0°.
 *
 * The same shape `encodeWalker` produces and for the same reason — one url
 * parameter that says what a caption would, rather than five that can arrive
 * inconsistent with each other. `97.99:5x100@650` is Suncatcher's cluster.
 */
export function encodeCluster(params: ClusterFormationParams): string {
  const head = `${trimNumber(params.inclinationDeg)}:${params.rings}x${trimNumber(params.pitchM)}@${trimNumber(params.altitudeKm)}`;
  const offset = params.raanOffsetDeg ?? 0;
  return offset === 0 ? head : `${head}+${trimNumber(offset)}`;
}

/** Undefined for anything that is not a valid cluster, so a bad url is simply no cluster. */
export function decodeCluster(wire: string): ClusterFormationParams | undefined {
  const match = /^(-?[\d.]+):(\d+)x([\d.]+)@([\d.]+)(?:\+([\d.]+))?$/.exec(wire.trim());
  if (!match) {
    return undefined;
  }
  const [, inclination, rings, pitch, altitude, offset] = match;
  const params: ClusterFormationParams = {
    inclinationDeg: Number(inclination),
    rings: Number(rings),
    pitchM: Number(pitch),
    altitudeKm: Number(altitude),
    ...(offset === undefined ? {} : { raanOffsetDeg: Number(offset) }),
  };
  return validateClusterFormation(params).ok ? params : undefined;
}

/** Up to 3 decimals, without a trailing `.000`. */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** What a generated cluster's tag starts with. Per-cluster, for the reason `WALKER_TAG_PREFIX` is. */
export const CLUSTER_TAG_PREFIX = "Cluster ";

/** The tag this cluster's satellites carry. */
export function clusterTagFor(params: ClusterFormationParams): string {
  return `${CLUSTER_TAG_PREFIX}${encodeCluster(params)}`;
}

/** Whether a tag names a generated cluster rather than a catalog group. */
export function isClusterTag(tag: string): boolean {
  return tag.startsWith(CLUSTER_TAG_PREFIX);
}

/** The name prefix for a cluster: its own wire form, for the reason `walkerNamePrefix` is. */
export function clusterNamePrefix(params: ClusterFormationParams): string {
  return `C${encodeCluster(params)}`;
}

/**
 * Where a cluster's satnums start.
 *
 * Bands of `MAX_CLUSTER_SATELLITES` from 1,400,000 up, chosen by a hash of the
 * wire form — above the range `walkerSatnumBase` can reach (900,000 plus 90 bands
 * of 5,000), because satnum is an identity: the propagation pool keeps one satrec
 * per satnum for the session, so a cluster landing on a Walker pattern's satnums
 * would fly that pattern's orbits.
 */
export function clusterSatnumBase(params: ClusterFormationParams): number {
  const wire = encodeCluster(params);
  let hash = 0;
  for (let index = 0; index < wire.length; index += 1) {
    hash = (hash * 31 + wire.charCodeAt(index)) % 90;
  }
  return 1400000 + hash * MAX_CLUSTER_SATELLITES;
}

/** The epoch every generated cluster is stated at — shared with the Walker patterns, so one scene has one reference instant. */
export const CLUSTER_EPOCH_ISO = WALKER_EPOCH_ISO;

/**
 * Clusters worth opening with.
 *
 * The first is Google's, to the metre, because a preset earns its place by being
 * checkable against something published: 81 satellites, 650 km dawn-dusk
 * sun-synchronous, 100 m x 200 m lattice, R = 1 km
 * (arXiv 2511.19468 §2.2). The others are the same design read small enough to
 * follow one satellite round its epicycle.
 */
export const CLUSTER_PRESETS: ReadonlyArray<{ label: string; note: string; params: ClusterFormationParams }> = [
  {
    label: "Suncatcher 81 @ 650 km",
    note: "Google's free-flying compute cluster: 81 satellites inside 1 km, dawn-dusk SSO, 100 m x 200 m lattice.",
    params: { inclinationDeg: 97.99, altitudeKm: 650, pitchM: 100, rings: 5 },
  },
  {
    label: "Minimal 13 @ 650 km",
    note: "Two rings — the smallest lattice that still fills its bounding ellipse, and few enough to watch one member.",
    params: { inclinationDeg: 97.99, altitudeKm: 650, pitchM: 100, rings: 2 },
  },
  {
    label: "Wide 29 @ 550 km",
    note: "Three rings at 200 m pitch: R = 1.2 km, the same shape spread far enough apart to read at a distance.",
    params: { inclinationDeg: 53, altitudeKm: 550, pitchM: 200, rings: 3 },
  },
  {
    label: "Visible 29 @ 550 km",
    note: "The same three-ring formation blown up to R = 120 km — the same dynamics, at a size a globe can draw. Members are tens of kilometres apart, so the bonds between them are lines rather than a pixel.",
    params: { inclinationDeg: 53, altitudeKm: 550, pitchM: 20000, rings: 3 },
  },
];

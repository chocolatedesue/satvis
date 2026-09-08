// What a cluster's geometry does over one cycle, as a curve rather than a claim.
//
// A cluster is a statement about rates, and the panel prints it as words: "returns
// every 24.46 h", "closest 1230 km against a 8791 km horizon". Neither is something
// a reader can check. At globe range the members are five shells nested inside each
// other, and the marked bonds between them are the only thing moving — which makes a
// stable cluster and a drifting one look alike for exactly as long as anyone watches.
//
// So the return gets drawn instead. Every term here is closed form: two secular
// rates, a position from them, and a straight-line range. No SGP4, no propagation
// pool, no epoch — which is the point, because a cycle is 24 hours and the thing
// being shown is that the curve's last sample is its first.
//
//   node run on:      Ω(t) = Ω₀ + Ω̇·t
//   along-track run:  u(t) = u₀ + u̇·t
//   position (ECI):   r·(cosΩ cos u − sinΩ sin u cos i,
//                        sinΩ cos u + cosΩ sin u cos i,
//                        sin u sin i)
//
// Secular J₂ two-body, as everywhere else in this directory.

import { circularSemiMajorAxisKm, orbitalRates, type CircularOrbit } from "./orbitModel.ts";
import { maxLinkRangeKm } from "./shellLayout.ts";

/** One satellite in the closed-form picture: an orbit, and where on it the satellite starts. */
export interface OrbitPhase extends CircularOrbit {
  /** Right ascension of the node at t = 0, in degrees. */
  nodeDeg: number;
  /** Argument of latitude at t = 0, in degrees — the angle that places a satellite in a circular orbit. */
  phaseDeg: number;
}

const DEG_TO_RAD = Math.PI / 180;

/** Where a satellite is, in kilometres, `hours` after the epoch. */
function positionKm(phase: OrbitPhase, hours: number): [number, number, number] {
  const rates = orbitalRates(phase);
  const node = (phase.nodeDeg + rates.nodeRateDegPerDay * (hours / 24)) * DEG_TO_RAD;
  const along = (phase.phaseDeg + rates.alongTrackRateDegPerDay * (hours / 24)) * DEG_TO_RAD;
  const tilt = phase.inclinationDeg * DEG_TO_RAD;
  const radius = circularSemiMajorAxisKm(phase.altitudeKm);
  const cosU = Math.cos(along);
  const sinU = Math.sin(along);
  return [
    radius * (Math.cos(node) * cosU - Math.sin(node) * sinU * Math.cos(tilt)),
    radius * (Math.sin(node) * cosU + Math.cos(node) * sinU * Math.cos(tilt)),
    radius * sinU * Math.sin(tilt),
  ];
}

/** The straight-line range between two satellites, `hours` after the epoch. */
export function rangeKm(a: OrbitPhase, b: OrbitPhase, hours: number): number {
  const [ax, ay, az] = positionKm(a, hours);
  const [bx, by, bz] = positionKm(b, hours);
  return Math.hypot(ax - bx, ay - by, az - bz);
}

/** One sample of a cluster's internal geometry. */
export interface ContactSample {
  /** Hours since the epoch. */
  hours: number;
  /** The range of the closest pair, in kilometres. */
  closestKm: number;
  /** How many pairs are inside their own link horizon — how much fabric exists right now. */
  linkedPairs: number;
}

export interface ContactSeries {
  /** The samples, evenly spaced over one cycle. */
  samples: ContactSample[];
  /** The tightest link horizon among the pairs — the bar a pair has to beat to be a link. */
  horizonKm: number;
  /** How many pairs the cluster has. */
  pairs: number;
  /** Share of the cycle in which at least one pair is in contact. */
  linkedFraction: number;
  /**
   * How far the last sample is from the first, in kilometres — the return, measured
   * rather than asserted. A cluster that closes its cycle puts this near zero; one
   * that only nearly does leaves the slip the solver reported.
   */
  closureKm: number;
}

/**
 * The cluster's internal ranges across one cycle.
 *
 * Sampled rather than solved: the range between two circular orbits is a closed
 * form in `t`, but the closest of N pairs is a min over pairs, and the count in
 * contact is a step function, so neither has a useful analytic shape. 120 samples
 * resolve a contact window a hundredth of a cycle long, which is finer than the
 * secular model itself.
 *
 * The pair horizon is per pair, because it is a statement about two altitudes:
 * two high shells see further over the planet than a high one and a low one.
 */
export function contactSeries(members: readonly OrbitPhase[], cycleHours: number, samples = 120): ContactSeries {
  const pairs: Array<[number, number]> = [];
  const horizons: number[] = [];
  for (let a = 0; a < members.length; a += 1) {
    for (let b = a + 1; b < members.length; b += 1) {
      const first = members[a] as OrbitPhase;
      const second = members[b] as OrbitPhase;
      pairs.push([a, b]);
      horizons.push(maxLinkRangeKm(first.altitudeKm, second.altitudeKm));
    }
  }
  const series: ContactSample[] = [];
  let linked = 0;
  for (let index = 0; index <= samples; index += 1) {
    const hours = (index / samples) * cycleHours;
    let closestKm = Infinity;
    let linkedPairs = 0;
    for (let pair = 0; pair < pairs.length; pair += 1) {
      const [a, b] = pairs[pair] as [number, number];
      const distance = rangeKm(members[a] as OrbitPhase, members[b] as OrbitPhase, hours);
      closestKm = Math.min(closestKm, distance);
      if (distance <= (horizons[pair] as number)) {
        linkedPairs += 1;
      }
    }
    if (linkedPairs > 0) {
      linked += 1;
    }
    series.push({ hours, closestKm: Number.isFinite(closestKm) ? closestKm : 0, linkedPairs });
  }
  const first = series[0] as ContactSample;
  const last = series[series.length - 1] as ContactSample;
  return {
    samples: series,
    horizonKm: horizons.length > 0 ? Math.min(...horizons) : 0,
    pairs: pairs.length,
    linkedFraction: series.length > 0 ? linked / series.length : 0,
    closureKm: Math.abs(last.closestKm - first.closestKm),
  };
}

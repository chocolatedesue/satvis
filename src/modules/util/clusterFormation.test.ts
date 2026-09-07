import { propagate } from "satellite.js";
import { describe, expect, it } from "vitest";

import {
  CLUSTER_EPOCH_ISO,
  CLUSTER_PRESETS,
  clusterFormationRecords,
  clusterLattice,
  clusterNamePrefix,
  clusterRadiusM,
  clusterSatnumBase,
  clusterSize,
  clusterTagFor,
  decodeCluster,
  encodeCluster,
  isClusterTag,
  latticeIndexOf,
  latticeMemberElements,
  latticeTag,
  MAX_CLUSTER_SATELLITES,
  MAX_ECCENTRICITY,
  maxEccentricity,
  validateClusterFormation,
  type ClusterFormationParams,
} from "./clusterFormation";
import { createSatrec } from "./gp";
import { offsetIn, ricBasis, type RicBasis, type Vec3 } from "./relativeFrame";
import { planeSlotOf, walkerSatnumBase, WALKER_PRESETS } from "./walkerDelta";

const EPOCH = new Date(CLUSTER_EPOCH_ISO);

/** Google's cluster, arXiv 2511.19468 §2.2: 81 satellites inside 1 km at 650 km dawn-dusk SSO. */
const suncatcher: ClusterFormationParams = { inclinationDeg: 97.99, altitudeKm: 650, pitchM: 100, rings: 5 };

describe("clusterLattice", () => {
  it("is the integer points of a disc, reference first", () => {
    expect(clusterLattice(0)).toEqual([[0, 0]]);
    expect(clusterLattice(1)).toHaveLength(5);
    expect(clusterLattice(2)).toHaveLength(13);
    expect(clusterLattice(5)[0]).toEqual([0, 0]);
  });

  it("gives Suncatcher's 81 members at five rings", () => {
    expect(clusterSize(5)).toBe(81);
  });

  it("holds every member inside the ring count", () => {
    for (const [i, j] of clusterLattice(5)) {
      expect(i * i + j * j).toBeLessThanOrEqual(25);
    }
  });
});

describe("clusterRadiusM", () => {
  it("reads Suncatcher's R as 1 km", () => {
    expect(clusterRadiusM(suncatcher)).toBe(1000);
  });
});

describe("validateClusterFormation", () => {
  it("accepts the presets", () => {
    for (const preset of CLUSTER_PRESETS) {
      expect(validateClusterFormation(preset.params).ok).toBe(true);
    }
  });

  it("refuses a lattice past the satellite cap", () => {
    const result = validateClusterFormation({ ...suncatcher, rings: 40 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(String(MAX_CLUSTER_SATELLITES));
  });

  it("allows a formation big enough to see on a globe", () => {
    // 120 km across. The dynamics are the Suncatcher ones; only the scale differs,
    // and the scale is what decides whether the members are a pixel or a picture.
    expect(validateClusterFormation({ inclinationDeg: 53, altitudeKm: 550, pitchM: 20000, rings: 3 }).ok).toBe(true);
  });

  it("refuses a formation past the linear model's reach", () => {
    const params = { ...suncatcher, pitchM: 30000, rings: 5 };
    expect(maxEccentricity(params)).toBeGreaterThan(MAX_ECCENTRICITY);
    expect(validateClusterFormation(params).ok).toBe(false);
  });

  it("refuses a non-integer ring count and a zero pitch", () => {
    expect(validateClusterFormation({ ...suncatcher, rings: 2.5 }).ok).toBe(false);
    expect(validateClusterFormation({ ...suncatcher, pitchM: 0 }).ok).toBe(false);
  });
});

describe("latticeMemberElements", () => {
  const semiMajorAxisM = (6378.135 + 650) * 1000;

  it("puts the reference on a circular orbit", () => {
    const centre = latticeMemberElements(0, 0, 100, semiMajorAxisM);
    expect(centre.eccentricity).toBe(0);
  });

  it("states the epicycle amplitude as an eccentricity", () => {
    // The outermost members all reach A = pitch * rings = 500 m, whichever
    // direction they sit in — that is what the 1:2 lattice buys.
    for (const [i, j] of [[5, 0], [0, 5], [3, 4], [-4, -3]] as Array<[number, number]>) {
      const { eccentricity } = latticeMemberElements(i, j, 100, semiMajorAxisM);
      expect(eccentricity * semiMajorAxisM).toBeCloseTo(500, 6);
    }
  });

  it("holds every epicycle centre on the reference", () => {
    // omega + M is the argument of latitude, and it is the same for every member:
    // that is what keeps the formation from spreading along-track.
    for (const [i, j] of clusterLattice(5)) {
      const { argOfPericenterDeg, meanAnomalyDeg } = latticeMemberElements(i, j, 100, semiMajorAxisM, 0);
      expect((argOfPericenterDeg + meanAnomalyDeg) % 360).toBeCloseTo(0, 6);
    }
  });
});

describe("clusterFormationRecords", () => {
  const records = clusterFormationRecords(suncatcher, EPOCH);

  it("generates one record per lattice point", () => {
    expect(records).toHaveLength(81);
  });

  it("shares one epoch and one mean motion across every member", () => {
    const omms = records.map((record) => (record.kind === "omm" ? record.omm : undefined));
    expect(new Set(omms.map((omm) => omm?.EPOCH)).size).toBe(1);
    // Not "close to": the sample grids in sgp4Worker are anchored to the epoch and
    // stepped by the period, so equal to the last bit is what makes the
    // interpolation error common-mode across the formation.
    expect(new Set(omms.map((omm) => omm?.MEAN_MOTION)).size).toBe(1);
    expect(new Set(omms.map((omm) => omm?.INCLINATION)).size).toBe(1);
    expect(new Set(omms.map((omm) => omm?.RA_OF_ASC_NODE)).size).toBe(1);
  });

  it("gives every member a distinct satnum and name", () => {
    const omms = records.flatMap((record) => (record.kind === "omm" ? [record.omm] : []));
    expect(new Set(omms.map((omm) => omm.NORAD_CAT_ID)).size).toBe(81);
    expect(new Set(omms.map((omm) => omm.OBJECT_NAME)).size).toBe(81);
  });

  it("refuses an unbuildable cluster rather than generating a partial one", () => {
    expect(clusterFormationRecords({ ...suncatcher, rings: -1 }, EPOCH)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The claim, flown
// ---------------------------------------------------------------------------
//
// Everything above checks the arithmetic against itself. This checks it against
// SGP4 — the propagator the app actually flies these records with, J2 included —
// and against the numbers Google's paper quotes for the same cluster. If the
// eccentricity-vector mapping is wrong, this is where it shows.

const MU_KM3_S2 = 398600.8;
const SEMI_MAJOR_AXIS_KM = 6378.135 + 650;
const PERIOD_SECONDS = 2 * Math.PI * Math.sqrt(SEMI_MAJOR_AXIS_KM ** 3 / MU_KM3_S2);

/** The whole formation's state at one instant: the reference's own frame, and where everyone is. */
function flyTo(satrecs: ReturnType<typeof createSatrec>[], secondsFromEpoch: number): { basis: RicBasis; reference: Vec3; positions: Vec3[] } {
  const time = new Date(EPOCH.getTime() + secondsFromEpoch * 1000);
  const states = satrecs.map((satrec) => propagate(satrec, time));
  const first = states[0];
  if (!first?.position || !first.velocity) {
    throw new Error("the reference satellite did not propagate");
  }
  const reference: Vec3 = [first.position.x, first.position.y, first.position.z];
  return {
    basis: ricBasis(reference, [first.velocity.x, first.velocity.y, first.velocity.z]),
    reference,
    positions: states.map((state) => {
      if (!state?.position) {
        throw new Error("a member did not propagate");
      }
      return [state.position.x, state.position.y, state.position.z];
    }),
  };
}

/** Kilometres in, metres out — element sets are quoted in km and formations in m. */
function offsetsM(state: ReturnType<typeof flyTo>, basis = state.basis): Array<[number, number, number]> {
  return state.positions.map((position) => {
    const [radial, alongTrack, crossTrack] = offsetIn(basis, state.reference, position);
    return [radial * 1000, alongTrack * 1000, crossTrack * 1000];
  });
}

/**
 * Every member's offset in the reference's *current* frame: the frame in which a
 * bounded formation sits still inside its ellipse.
 */
function relativeFrame(satrecs: ReturnType<typeof createSatrec>[], secondsFromEpoch: number): Array<[number, number, number]> {
  return offsetsM(flyTo(satrecs, secondsFromEpoch));
}

describe("the Suncatcher cluster, flown with SGP4", () => {
  const lattice = clusterLattice(suncatcher.rings);
  const satrecs = clusterFormationRecords(suncatcher, EPOCH).map(createSatrec);
  // S1: the member furthest along-track at epoch, which the paper singles out.
  const s1 = lattice.findIndex(([i, j]) => i === 0 && j === 5);
  const neighbours = lattice.flatMap(([i, j], at) => (Math.abs(i) <= 1 && Math.abs(j) <= 1 && (i !== 0 || j !== 0) ? [at] : []));

  it("starts as the lattice it was asked for, to within J2's short-period terms", () => {
    // The generator states *mean* elements; SGP4 reports *osculating* positions,
    // and J2's short-period terms sit between the two. They are common-mode to
    // several kilometres and differential to a few metres, which is what this
    // measures: the lattice is the one asked for, displaced by up to ~8 m. It is
    // a static distortion, not an error and not a drift — the tests below show it
    // neither grows nor moves. A formation specified as a *state* rather than as
    // elements (an integrator's initial conditions, say) starts exact instead and
    // acquires the same distortion within the first orbit.
    const frame = relativeFrame(satrecs, 0);
    let worst = 0;
    for (const [at, [i, j]] of lattice.entries()) {
      worst = Math.max(worst, Math.hypot(frame[at]![0]! - i * suncatcher.pitchM, frame[at]![1]! - j * 2 * suncatcher.pitchM));
    }
    expect(worst).toBeLessThan(10);
  });

  it("is coplanar", () => {
    for (const frame of [relativeFrame(satrecs, 0), relativeFrame(satrecs, PERIOD_SECONDS / 3)]) {
      expect(Math.max(...frame.map(([, , w]) => Math.abs(w)))).toBeLessThan(1);
    }
  });

  it("puts S1 at apogee a+R/2 at 3T/12 and perigee a-R/2 at 9T/12", () => {
    // The paper's own two hard anchors. Within a metre: SGP4 recovers a
    // semi-major axis a few km from the stated one, which scales the amplitude by
    // a part in ten thousand, and J2 adds its own tenth of a metre.
    expect(relativeFrame(satrecs, (3 * PERIOD_SECONDS) / 12)[s1]![0]).toBeCloseTo(500, -0.5);
    expect(relativeFrame(satrecs, (9 * PERIOD_SECONDS) / 12)[s1]![0]).toBeCloseTo(-500, -0.5);
  });

  it("oscillates its nearest-neighbour distances over 100-200 m, and its diagonals over 141-283 m", () => {
    let directMin = Infinity;
    let directMax = 0;
    let diagonalMin = Infinity;
    let diagonalMax = 0;
    for (let step = 0; step <= 240; step += 1) {
      const frame = relativeFrame(satrecs, (step * PERIOD_SECONDS) / 240);
      for (const at of neighbours) {
        const [i, j] = lattice[at]!;
        const distance = Math.hypot(frame[at]![0] - frame[0]![0], frame[at]![1] - frame[0]![1]);
        if (i !== 0 && j !== 0) {
          diagonalMin = Math.min(diagonalMin, distance);
          diagonalMax = Math.max(diagonalMax, distance);
        } else {
          directMin = Math.min(directMin, distance);
          directMax = Math.max(directMax, distance);
        }
      }
    }
    // The Keplerian design values are 100/200 and 141/283 — the paper's own
    // figures — and J2's short-period distortion widens each end by under 15 m.
    // Asserted as a band around the design rather than as the measured numbers,
    // so a change that broke the *design* fails here even if it happened to leave
    // the measurement plausible.
    expect(Math.abs(directMin - 100)).toBeLessThan(15);
    expect(Math.abs(directMax - 200)).toBeLessThan(15);
    expect(Math.abs(diagonalMin - 141.4)).toBeLessThan(15);
    expect(Math.abs(diagonalMax - 282.8)).toBeLessThan(15);
  });

  it("stays inside its stated radius for a whole orbit", () => {
    for (let step = 0; step <= 120; step += 1) {
      const frame = relativeFrame(satrecs, (step * PERIOD_SECONDS) / 120);
      // Under two percent of headroom: J2's short-period terms deform the
      // bounding ellipse slightly, which is the residual the paper's 2:1.0037
      // axis-ratio correction is there to cancel.
      expect(Math.max(...frame.map(([u, v]) => Math.hypot(u, v)))).toBeLessThan(clusterRadiusM(suncatcher) * 1.02);
    }
  });

  it("comes back to its own shape after one orbit", () => {
    const start = relativeFrame(satrecs, 0);
    const end = relativeFrame(satrecs, PERIOD_SECONDS);
    const worst = Math.max(...start.map(([u, v], at) => Math.hypot(u - end[at]![0], v - end[at]![1])));
    // The paper's "perfect repeat at zero delta-v". It comes out at centimetres
    // rather than exactly zero, and it is *because* every member shares a mean
    // motion to the last bit: what J2 does to the formation, it does to all of it.
    expect(worst).toBeLessThan(0.5);
  });

  it("holds its bounding ellipse still in the rotating frame", () => {
    // The formation does not breathe in the frame that turns with it — that is
    // what "bounded" means. Wide along-track, half as tall, and the same shape at
    // every twelfth of the orbit.
    for (let twelfth = 0; twelfth <= 12; twelfth += 1) {
      const frame = relativeFrame(satrecs, (twelfth * PERIOD_SECONDS) / 12);
      const alongTrack = Math.max(...frame.map(([, v]) => Math.abs(v)));
      const radial = Math.max(...frame.map(([u]) => Math.abs(u)));
      expect(alongTrack / radial).toBeGreaterThan(1.9);
      expect(alongTrack / radial).toBeLessThan(2.1);
    }
  });

  it("deforms twice per orbit in the frame Fig 2 is drawn in", () => {
    // The shape cycle is a property of the *non-rotating* frame — the paper's
    // caption says as much — and measuring it in the rotating one is how you
    // conclude, wrongly, that nothing happens. Captured at epoch and held still,
    // the ellipse turns with the orbit: flat at T=0, upright a quarter turn later,
    // flat again at the half. Twice per revolution, which is the figure's
    // "two shape-cycles per full orbit".
    const epochBasis = flyTo(satrecs, 0).basis;
    const aspect = (twelfth: number) => {
      const frame = offsetsM(flyTo(satrecs, (twelfth * PERIOD_SECONDS) / 12), epochBasis);
      return Math.max(...frame.map(([, v]) => Math.abs(v))) / Math.max(...frame.map(([u]) => Math.abs(u)));
    };
    for (const twelfth of [0, 6, 12]) {
      expect(aspect(twelfth)).toBeGreaterThan(1.9);
    }
    for (const twelfth of [3, 9]) {
      expect(aspect(twelfth)).toBeLessThan(0.55);
    }
  });

  it("does not drift along-track over five orbits", () => {
    // The property the whole design rests on, and the one a wrong eccentricity or
    // an unequal mean motion would break first: a formation with any difference in
    // semi-major axis slides apart linearly, so five orbits of no growth is the
    // statement that there is none.
    const reach = (orbits: number) => Math.max(...relativeFrame(satrecs, orbits * PERIOD_SECONDS).map(([, v]) => Math.abs(v)));
    expect(Math.abs(reach(5) - reach(0))).toBeLessThan(1);
  });
});

describe("the wire form", () => {
  it("round-trips every preset", () => {
    for (const preset of CLUSTER_PRESETS) {
      expect(decodeCluster(encodeCluster(preset.params))).toEqual(preset.params);
    }
  });

  it("writes Suncatcher's cluster as one readable string", () => {
    expect(encodeCluster(suncatcher)).toBe("97.99:5x100@650");
    expect(clusterTagFor(suncatcher)).toBe("Cluster 97.99:5x100@650");
    expect(isClusterTag(clusterTagFor(suncatcher))).toBe(true);
    expect(isClusterTag("Weather")).toBe(false);
  });

  it("carries a raan offset only when there is one", () => {
    expect(encodeCluster({ ...suncatcher, raanOffsetDeg: 90 })).toBe("97.99:5x100@650+90");
    expect(decodeCluster("97.99:5x100@650+90")?.raanOffsetDeg).toBe(90);
  });

  it("is undefined for anything unusable", () => {
    expect(decodeCluster("")).toBeUndefined();
    expect(decodeCluster("53:1584/72/17@550")).toBeUndefined();
    expect(decodeCluster("97.99:40x100@650")).toBeUndefined();
  });
});

describe("names and satnums", () => {
  it("round-trips a lattice tag", () => {
    expect(latticeTag(0, 5)).toBe("L+00+05");
    expect(latticeTag(-5, 0)).toBe("L-05+00");
    expect(latticeIndexOf(`${clusterNamePrefix(suncatcher)} L-05+00`)).toEqual({ i: -5, j: 0 });
    expect(latticeIndexOf("ISS (ZARYA)")).toBeUndefined();
  });

  it("does not name members the way constellationLinks reads planes and slots", () => {
    // A cluster has no planes, so the ring and inter-plane topology must find
    // nothing to wire across it.
    for (const record of clusterFormationRecords(suncatcher, EPOCH)) {
      expect(planeSlotOf(record.kind === "omm" ? record.omm.OBJECT_NAME : undefined)).toBeUndefined();
    }
  });

  it("keeps its satnums clear of the Walker bands", () => {
    const walkerTop = Math.max(...WALKER_PRESETS.map((preset) => walkerSatnumBase(preset.params))) + 5000;
    for (const preset of CLUSTER_PRESETS) {
      expect(clusterSatnumBase(preset.params)).toBeGreaterThan(walkerTop);
    }
  });
});

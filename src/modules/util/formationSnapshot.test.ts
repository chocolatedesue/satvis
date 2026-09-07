import { describe, expect, it } from "vitest";

import { CLUSTER_EPOCH_ISO, clusterRadiusM, type ClusterFormationParams } from "./clusterFormation";
import { formationBasis, formationSatrecs, formationSnapshot, meanMotionRadPerSec } from "./formationSnapshot";

const EPOCH = new Date(CLUSTER_EPOCH_ISO);
const suncatcher: ClusterFormationParams = { inclinationDeg: 97.99, altitudeKm: 650, pitchM: 100, rings: 5 };

const satrecs = formationSatrecs(suncatcher, EPOCH);
const rate = meanMotionRadPerSec(suncatcher);
const PERIOD_SECONDS = (2 * Math.PI) / rate;

function at(seconds: number, frameSeconds = seconds) {
  const when = new Date(EPOCH.getTime() + seconds * 1000);
  const frameEpoch = new Date(EPOCH.getTime() + frameSeconds * 1000);
  const basis = formationBasis(satrecs, frameEpoch);
  if (!basis) {
    throw new Error("no basis");
  }
  return formationSnapshot(suncatcher, satrecs, when, basis, frameEpoch, rate);
}

describe("formationSnapshot", () => {
  it("places every member and keeps its lattice identity", () => {
    const snapshot = at(0);
    expect(snapshot.members).toHaveLength(81);
    expect(snapshot.members[0]).toMatchObject({ i: 0, j: 0 });
    expect(snapshot.radiusM).toBe(clusterRadiusM(suncatcher));
  });

  it("puts the reference at the origin", () => {
    const [reference] = at(0).members;
    expect(Math.hypot(reference!.radial, reference!.alongTrack)).toBeLessThan(1e-6);
  });

  it("starts as the lattice, in metres", () => {
    const snapshot = at(0);
    const s1 = snapshot.members.find((m) => m.i === 0 && m.j === 5);
    expect(s1!.alongTrack).toBeGreaterThan(990);
    expect(s1!.alongTrack).toBeLessThan(1010);
  });
});

describe("the rotating frame", () => {
  it("holds the formation inside a fixed ellipse, twice as wide as it is tall", () => {
    for (let twelfth = 0; twelfth <= 12; twelfth += 1) {
      const { members } = at((twelfth * PERIOD_SECONDS) / 12);
      const alongTrack = Math.max(...members.map((m) => Math.abs(m.alongTrack)));
      const radial = Math.max(...members.map((m) => Math.abs(m.radial)));
      expect(alongTrack / radial).toBeGreaterThan(1.9);
      expect(alongTrack / radial).toBeLessThan(2.1);
    }
  });

  it("reports no ellipse rotation, because there is none", () => {
    expect(at(PERIOD_SECONDS / 3).ellipseAngleRad).toBe(0);
  });
});

describe("the non-rotating frame", () => {
  // The frame Google's figure is drawn in, and the only one the deformation shows
  // up in: the basis is captured once and held while the satellite flies on.
  const frameSeconds = 0;

  it("turns the formation from wide to tall and back, twice per orbit", () => {
    const aspect = (twelfth: number) => {
      const { members } = at((twelfth * PERIOD_SECONDS) / 12, frameSeconds);
      return Math.max(...members.map((m) => Math.abs(m.alongTrack))) / Math.max(...members.map((m) => Math.abs(m.radial)));
    };
    for (const twelfth of [0, 6, 12]) {
      expect(aspect(twelfth)).toBeGreaterThan(1.9);
    }
    for (const twelfth of [3, 9]) {
      expect(aspect(twelfth)).toBeLessThan(0.55);
    }
  });

  it("turns the bounding ellipse at the orbital rate", () => {
    // A quarter of an orbit is a quarter turn — which is what makes the wide
    // frame tall, and why a drawing needs the angle rather than guessing it.
    expect(at(PERIOD_SECONDS / 4, frameSeconds).ellipseAngleRad).toBeCloseTo(Math.PI / 2, 3);
    expect(at(PERIOD_SECONDS, frameSeconds).ellipseAngleRad).toBeCloseTo(2 * Math.PI, 3);
  });

  it("stays inside the stated radius all the way round", () => {
    for (let step = 0; step <= 24; step += 1) {
      const { members, radiusM } = at((step * PERIOD_SECONDS) / 24, frameSeconds);
      expect(Math.max(...members.map((m) => Math.hypot(m.radial, m.alongTrack)))).toBeLessThan(radiusM * 1.02);
    }
  });
});

describe("meanMotionRadPerSec", () => {
  it("agrees with the period a 650 km orbit has", () => {
    expect((2 * Math.PI) / meanMotionRadPerSec(suncatcher)).toBeCloseTo(5863.7, 0);
  });
});

import { describe, expect, it } from "vitest";

import { chooseTarget, decideMigration, distanceKm, initialHost, lerp, type MigrationHost, noPower, SPEED_OF_LIGHT_KM_S, transferCost, type Vec3 } from "./migration";

const at = (name: string, position: Vec3, hasPower: boolean): MigrationHost => ({ name, position, hasPower });
const km = (x: number): Vec3 => ({ x: x * 1000, y: 0, z: 0 });

describe("noPower", () => {
  it("treats only the two lit-panel states as powered", () => {
    expect(noPower("sunlit_on")).toBe(false);
    expect(noPower("sunlit_edge")).toBe(false);
    expect(noPower("sunlit_back")).toBe(true);
    expect(noPower("umbra")).toBe(true);
    expect(noPower("penumbra")).toBe(true);
  });
});

describe("distanceKm", () => {
  it("is the chord length in km, from metre coordinates", () => {
    expect(distanceKm({ x: 0, y: 0, z: 0 }, { x: 3000, y: 4000, z: 0 })).toBeCloseTo(5, 9);
  });

  it("is symmetric and zero for a point against itself", () => {
    const a = { x: 1234, y: -5678, z: 9012 };
    const b = { x: -42, y: 17, z: 8 };
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 9);
    expect(distanceKm(a, a)).toBe(0);
  });
});

describe("lerp", () => {
  it("returns the endpoints at 0 and 1", () => {
    const a = km(0);
    const b = km(10);
    expect(lerp(a, b, 0)).toEqual(a);
    expect(lerp(a, b, 1)).toEqual(b);
  });

  it("is the midpoint at 0.5", () => {
    expect(lerp(km(0), km(10), 0.5)).toEqual(km(5));
  });

  it("clamps a fraction outside [0, 1] to the segment", () => {
    expect(lerp(km(0), km(10), -1)).toEqual(km(0));
    expect(lerp(km(0), km(10), 2)).toEqual(km(10));
  });
});

describe("transferCost", () => {
  it("serialises GB against Gbps as GB*8/Gbps seconds", () => {
    // 2 GB over 100 Gbps = 16 gigabit / 100 Gbps = 0.16 s.
    const cost = transferCost(2, 100, 0);
    expect(cost.serializeSeconds).toBeCloseTo(0.16, 9);
    expect(cost.propagationSeconds).toBe(0);
    expect(cost.totalSeconds).toBeCloseTo(0.16, 9);
  });

  it("adds one-way light travel over the link", () => {
    const linkKm = SPEED_OF_LIGHT_KM_S; // one light-second of link
    const cost = transferCost(0, 100, linkKm);
    expect(cost.propagationSeconds).toBeCloseTo(1, 9);
    expect(cost.totalSeconds).toBeCloseTo(1, 9);
  });

  it("reports an infinite serialisation over a dead link rather than dividing by zero", () => {
    expect(transferCost(2, 0, 100).serializeSeconds).toBe(Infinity);
  });

  it("is dominated by serialisation for a few GB over a LEO-scale link", () => {
    const cost = transferCost(2, 100, 2000);
    expect(cost.serializeSeconds).toBeGreaterThan(cost.propagationSeconds * 10);
  });
});

describe("chooseTarget", () => {
  const source = at("SRC", km(0), false);

  it("picks the nearest powered candidate", () => {
    const target = chooseTarget(source, [at("far", km(100), true), at("near", km(10), true), at("dark", km(1), false)]);
    expect(target?.name).toBe("near");
  });

  it("skips the source itself even when it appears in the list", () => {
    const target = chooseTarget(source, [{ ...source, hasPower: true }, at("other", km(50), true)]);
    expect(target?.name).toBe("other");
  });

  it("returns undefined when no candidate is powered", () => {
    expect(chooseTarget(source, [at("a", km(10), false), at("b", km(20), false)])).toBeUndefined();
  });

  it("is deterministic on a tie, keeping the first seen", () => {
    const target = chooseTarget(source, [at("first", km(10), true), at("second", km(10), true)]);
    expect(target?.name).toBe("first");
  });
});

describe("decideMigration", () => {
  it("holds while the host is powered", () => {
    const hosts = [at("H", km(0), true), at("N", km(10), true)];
    expect(decideMigration("H", hosts).action).toBe("hold");
  });

  it("migrates to the nearest lit neighbour when the host goes dark", () => {
    const hosts = [at("H", km(0), false), at("near", km(5), true), at("far", km(50), true)];
    const decision = decideMigration("H", hosts);
    expect(decision.action).toBe("migrate");
    expect(decision.target?.name).toBe("near");
  });

  it("reports stranded when the host is dark and nothing is lit", () => {
    const hosts = [at("H", km(0), false), at("N", km(10), false)];
    expect(decideMigration("H", hosts).action).toBe("stranded");
  });

  it("reports stranded when the named host is not in the list", () => {
    expect(decideMigration("gone", [at("N", km(10), true)]).action).toBe("stranded");
    expect(decideMigration(undefined, [at("N", km(10), true)]).action).toBe("stranded");
  });
});

describe("initialHost", () => {
  it("prefers the first powered host", () => {
    expect(initialHost([at("dark", km(0), false), at("lit", km(10), true)])?.name).toBe("lit");
  });

  it("falls back to the first host when none is powered", () => {
    expect(initialHost([at("a", km(0), false), at("b", km(10), false)])?.name).toBe("a");
  });

  it("is undefined for an empty fleet", () => {
    expect(initialHost([])).toBeUndefined();
  });
});

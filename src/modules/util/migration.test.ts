import { describe, expect, it } from "vitest";

import {
  accrueTime,
  chooseTarget,
  chooseTargetExcluding,
  decideMigration,
  decideStageMigration,
  distanceKm,
  EARTH_RADIUS_KM,
  emptyLedger,
  hasLineOfSight,
  initialHost,
  lerp,
  type MigrationHost,
  noPower,
  placeStages,
  pipelineServing,
  poweredStageCount,
  recordMigration,
  allPoweredFraction,
  SPEED_OF_LIGHT_KM_S,
  transferCost,
  type Vec3,
} from "./migration";

const at = (name: string, position: Vec3, hasPower: boolean): MigrationHost => ({ name, position, hasPower });
const km = (x: number): Vec3 => ({ x: x * 1000, y: 0, z: 0 });

/**
 * A point on a 550 km circular orbit, `degrees` around from the +x axis, in metres.
 *
 * The `km` helper above puts points on a ray out of the origin, which is Earth's
 * centre — fine for pure distance arithmetic, but any test touching line of sight
 * needs positions that are actually in orbit, or the segment starts inside the
 * planet and every link is occluded.
 */
const ORBIT_RADIUS_M = 6921 * 1000;
const orbit = (degrees: number): Vec3 => ({
  x: ORBIT_RADIUS_M * Math.cos((degrees * Math.PI) / 180),
  y: ORBIT_RADIUS_M * Math.sin((degrees * Math.PI) / 180),
  z: 0,
});

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

describe("hasLineOfSight", () => {
  it("sees a close neighbour on the same side of the Earth", () => {
    expect(hasLineOfSight(orbit(0), orbit(20))).toBe(true);
  });

  it("is blocked by the Earth for a satellite diametrically opposite", () => {
    expect(hasLineOfSight(orbit(0), orbit(180))).toBe(false);
  });

  it("is blocked for the ~11,000 km chord the naive nearest-powered rule used to pick", () => {
    // 2*R*sin(θ/2) at θ ≈ 108° is ~11,200 km, and that chord passes ~4,060 km from
    // the centre — the case the migration log exposed.
    expect(distanceKm(orbit(0), orbit(108))).toBeGreaterThan(11_000);
    expect(hasLineOfSight(orbit(0), orbit(108))).toBe(false);
  });

  it("is symmetric", () => {
    expect(hasLineOfSight(orbit(30), orbit(150))).toBe(hasLineOfSight(orbit(150), orbit(30)));
  });

  it("does not call a near pair blocked by the far limb — closest approach is clamped to the segment", () => {
    expect(hasLineOfSight(orbit(0), orbit(2))).toBe(true);
  });

  it("treats a satellite against itself as visible rather than dividing by zero", () => {
    expect(hasLineOfSight(orbit(0), orbit(0))).toBe(true);
  });

  it("refuses a grazing link that would cross the atmosphere", () => {
    // A chord whose closest approach is 6400 km: above the solid Earth (6371 km) but
    // inside the 80 km margin, so refused with the margin and allowed without it.
    const grazing = (Math.acos(6400 / 6921) * 2 * 180) / Math.PI;
    expect(hasLineOfSight(orbit(0), orbit(grazing), 80)).toBe(false);
    expect(hasLineOfSight(orbit(0), orbit(grazing), 0)).toBe(true);
  });

  it("puts the blocking sphere at Earth's mean radius", () => {
    expect(EARTH_RADIUS_KM).toBe(6371);
  });
});

describe("chooseTargetExcluding", () => {
  const host = at("host", orbit(0), false);

  it("skips a lit candidate another stage already occupies", () => {
    const target = chooseTargetExcluding(host, [at("near", orbit(10), true), at("far", orbit(40), true)], new Set(["near"]));
    expect(target?.name).toBe("far");
  });

  it("picks the nearest in-view lit candidate when nothing is taken", () => {
    expect(chooseTargetExcluding(host, [at("far", orbit(40), true), at("near", orbit(10), true)], new Set())?.name).toBe("near");
  });

  it("returns undefined when every lit candidate is taken", () => {
    expect(chooseTargetExcluding(host, [at("a", orbit(10), true), at("b", orbit(20), true)], new Set(["a", "b"]))).toBeUndefined();
  });

  it("refuses a lit candidate the Earth is in the way of, preferring one in view", () => {
    const occluded = at("occluded", orbit(170), true);
    const visible = at("visible", orbit(40), true);
    expect(chooseTargetExcluding(host, [occluded, visible], new Set())?.name).toBe("visible");
  });

  it("returns undefined when the only lit candidate is behind the Earth", () => {
    expect(chooseTargetExcluding(host, [at("occluded", orbit(170), true)], new Set())).toBeUndefined();
  });
});

describe("decideStageMigration", () => {
  it("holds while the stage's host is powered", () => {
    expect(decideStageMigration("H", [at("H", orbit(0), true), at("N", orbit(10), true)], new Set()).action).toBe("hold");
  });

  it("migrates to the nearest free lit satellite in view", () => {
    const hosts = [at("H", orbit(0), false), at("taken", orbit(5), true), at("free", orbit(20), true)];
    const decision = decideStageMigration("H", hosts, new Set(["taken"]));
    expect(decision.action).toBe("migrate");
    expect(decision.target?.name).toBe("free");
  });

  it("strands the stage when every lit satellite belongs to a sibling", () => {
    const hosts = [at("H", orbit(0), false), at("taken", orbit(5), true)];
    expect(decideStageMigration("H", hosts, new Set(["taken"])).action).toBe("stranded");
  });

  it("strands the stage when the only lit satellite is behind the Earth", () => {
    const hosts = [at("H", orbit(0), false), at("across", orbit(180), true)];
    expect(decideStageMigration("H", hosts, new Set()).action).toBe("stranded");
  });

  it("reports an unplaced stage as stranded rather than throwing", () => {
    expect(decideStageMigration(undefined, [at("N", orbit(10), true)], new Set()).action).toBe("stranded");
  });
});

describe("placeStages", () => {
  const fleet = [at("dark", km(0), false), at("lit1", km(10), true), at("lit2", km(20), true)];

  it("gives every stage a distinct host", () => {
    const stages = placeStages(2, fleet);
    expect(stages.map((stage) => stage.hostName)).toEqual(["lit1", "lit2"]);
  });

  it("numbers the stages in pipeline order", () => {
    expect(placeStages(3, fleet).map((stage) => stage.index)).toEqual([0, 1, 2]);
  });

  it("falls back to unpowered satellites once the lit ones run out", () => {
    expect(placeStages(3, fleet).map((stage) => stage.hostName)).toEqual(["lit1", "lit2", "dark"]);
  });

  it("leaves a stage unplaced rather than co-locating when the fleet is too small", () => {
    expect(placeStages(2, [at("only", km(0), true)]).map((stage) => stage.hostName)).toEqual(["only", undefined]);
  });
});

describe("pipelineServing", () => {
  const hosts = [at("lit", km(0), true), at("lit2", km(10), true), at("dark", km(20), false)];

  it("serves only when every stage sits on a powered satellite", () => {
    expect(
      pipelineServing(
        [
          { index: 0, hostName: "lit" },
          { index: 1, hostName: "lit2" },
        ],
        hosts,
      ),
    ).toBe(true);
  });

  it("does not serve when one stage is dark — the conjunction is the point", () => {
    expect(
      pipelineServing(
        [
          { index: 0, hostName: "lit" },
          { index: 1, hostName: "dark" },
        ],
        hosts,
      ),
    ).toBe(false);
  });

  it("does not serve when a stage is unplaced", () => {
    expect(pipelineServing([{ index: 0, hostName: undefined }], hosts)).toBe(false);
  });

  it("does not serve an empty pipeline", () => {
    expect(pipelineServing([], hosts)).toBe(false);
  });
});

describe("poweredStageCount", () => {
  const hosts = [at("lit", km(0), true), at("dark", km(10), false)];

  it("counts the stages whose hosts have power", () => {
    expect(
      poweredStageCount(
        [
          { index: 0, hostName: "lit" },
          { index: 1, hostName: "dark" },
          { index: 2, hostName: undefined },
        ],
        hosts,
      ),
    ).toBe(1);
  });
});

describe("the ledger", () => {
  it("starts empty", () => {
    expect(emptyLedger()).toEqual({ migrations: 0, gigabytesMoved: 0, transferSeconds: 0, stalledSeconds: 0, allPoweredSeconds: 0 });
  });

  it("adds a migration's bytes and its cost", () => {
    const ledger = recordMigration(emptyLedger(), 2, transferCost(2, 100, 0));
    expect(ledger.migrations).toBe(1);
    expect(ledger.gigabytesMoved).toBe(2);
    expect(ledger.transferSeconds).toBeCloseTo(0.16, 9);
  });

  it("accumulates across migrations without mutating the input", () => {
    const first = emptyLedger();
    const second = recordMigration(first, 2, transferCost(2, 100, 0));
    const third = recordMigration(second, 2, transferCost(2, 100, 0));
    expect(first.migrations).toBe(0);
    expect(third.gigabytesMoved).toBe(4);
  });

  it("attributes elapsed simulated time to serving or stalling", () => {
    const served = accrueTime(emptyLedger(), 10, true, 3600);
    expect(served).toMatchObject({ allPoweredSeconds: 10, stalledSeconds: 0 });
    expect(accrueTime(served, 5, false, 3600)).toMatchObject({ allPoweredSeconds: 10, stalledSeconds: 5 });
  });

  it("drops a clock jump rather than counting it as time the pipeline lived through", () => {
    const ledger = emptyLedger();
    expect(accrueTime(ledger, 7200, true, 3600)).toBe(ledger);
    expect(accrueTime(ledger, -30, true, 3600)).toBe(ledger);
    expect(accrueTime(ledger, Number.NaN, true, 3600)).toBe(ledger);
  });

  it("reports the served fraction, and withholds it before any time is accounted", () => {
    expect(allPoweredFraction(emptyLedger())).toBeUndefined();
    const ledger = accrueTime(accrueTime(emptyLedger(), 30, true, 3600), 10, false, 3600);
    expect(allPoweredFraction(ledger)).toBeCloseTo(0.75, 9);
  });
});

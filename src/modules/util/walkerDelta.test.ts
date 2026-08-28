import { constants, gstime, propagate } from "satellite.js";
import { describe, expect, it } from "vitest";

import { createSatrec, orbitClassOf } from "./gp";
import {
  decodeWalker,
  encodeWalker,
  MAX_WALKER_SATELLITES,
  meanMotionRevPerDay,
  planeSlotOf,
  satsPerPlane,
  validateWalkerDelta,
  isWalkerTag,
  WALKER_PRESETS,
  walkerDeltaRecords,
  walkerNamePrefix,
  walkerSatnumBase,
  walkerTagFor,
  type WalkerDeltaParams,
} from "./walkerDelta";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

const starlinkShell1: WalkerDeltaParams = { total: 1584, planes: 72, phasing: 17, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
const minimal: WalkerDeltaParams = { total: 6, planes: 3, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };

function ommOf(record: ReturnType<typeof walkerDeltaRecords>[number]): Record<string, unknown> {
  if (record.kind !== "omm") {
    throw new Error("expected an OMM record");
  }
  return record.omm as unknown as Record<string, unknown>;
}

describe("validateWalkerDelta", () => {
  it("accepts a pattern whose planes divide evenly", () => {
    expect(validateWalkerDelta(starlinkShell1).ok).toBe(true);
  });

  it("refuses a T that does not fill P planes", () => {
    const result = validateWalkerDelta({ ...minimal, total: 7 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("7 satellites cannot fill 3 planes");
  });

  it("refuses a pattern above the typo ceiling", () => {
    expect(validateWalkerDelta({ ...minimal, total: MAX_WALKER_SATELLITES + 2, planes: 2 }).ok).toBe(false);
  });

  it("refuses an altitude no orbit survives", () => {
    expect(validateWalkerDelta({ ...minimal, altitudeKm: 80 }).ok).toBe(false);
  });

  it("refuses a RAAN span outside (0, 360]", () => {
    expect(validateWalkerDelta({ ...minimal, raanSpanDeg: 0 }).ok).toBe(false);
    expect(validateWalkerDelta({ ...minimal, raanSpanDeg: 361 }).ok).toBe(false);
    expect(validateWalkerDelta({ ...minimal, raanSpanDeg: 180 }).ok).toBe(true);
  });
});

describe("meanMotionRevPerDay", () => {
  it("puts a 550 km orbit near 15.05 rev/day", () => {
    // 95.7 min a revolution, which is the period the 550 km shell is quoted at.
    expect(meanMotionRevPerDay(550)).toBeCloseTo(15.05, 1);
  });

  it("puts a geosynchronous altitude at one revolution a day", () => {
    expect(meanMotionRevPerDay(35786)).toBeCloseTo(1.0027, 3);
  });
});

describe("walkerDeltaRecords", () => {
  it("generates T satellites in P planes", () => {
    const records = walkerDeltaRecords(starlinkShell1, EPOCH);
    expect(records).toHaveLength(1584);
    expect(satsPerPlane(starlinkShell1)).toBe(22);
    const raans = new Set(records.map((record) => Number(ommOf(record).RA_OF_ASC_NODE)));
    expect(raans.size).toBe(72);
  });

  it("spreads the planes evenly over the RAAN span", () => {
    const records = walkerDeltaRecords(minimal, EPOCH);
    const raans = [...new Set(records.map((record) => Number(ommOf(record).RA_OF_ASC_NODE)))].sort((a, b) => a - b);
    expect(raans).toEqual([0, 120, 240]);
  });

  it("halves the plane spacing for a Walker Star span", () => {
    const records = walkerDeltaRecords({ ...minimal, raanSpanDeg: 180 }, EPOCH);
    const raans = [...new Set(records.map((record) => Number(ommOf(record).RA_OF_ASC_NODE)))].sort((a, b) => a - b);
    expect(raans).toEqual([0, 60, 120]);
  });

  it("applies Walker's F as an inter-plane along-track offset of 360/T", () => {
    // 6/3/1: within a plane the two satellites are 180° apart, and each plane is
    // offset from the previous one by F * 360/T = 60°.
    const anomalies = walkerDeltaRecords(minimal, EPOCH).map((record) => Number(ommOf(record).MEAN_ANOMALY));
    expect(anomalies).toEqual([0, 180, 60, 240, 120, 300]);
  });

  it("leaves the along-track positions plane-independent at F = 0", () => {
    const anomalies = walkerDeltaRecords({ ...minimal, phasing: 0 }, EPOCH).map((record) => Number(ommOf(record).MEAN_ANOMALY));
    expect(anomalies).toEqual([0, 180, 0, 180, 0, 180]);
  });

  it("generates nothing for an invalid pattern rather than throwing", () => {
    expect(walkerDeltaRecords({ ...minimal, total: 7 }, EPOCH)).toEqual([]);
  });

  it("keeps satnums out of the real catalog's range and unique", () => {
    const records = walkerDeltaRecords(minimal, EPOCH);
    const satnums = records.map((record) => Number(ommOf(record).NORAD_CAT_ID));
    expect(new Set(satnums).size).toBe(satnums.length);
    expect(Math.min(...satnums)).toBeGreaterThan(500000);
  });

  it("names each satellite by its plane and slot", () => {
    const records = walkerDeltaRecords(minimal, EPOCH);
    expect(records.map((record) => ommOf(record).OBJECT_NAME)).toEqual(["WALKER P01-01", "WALKER P01-02", "WALKER P02-01", "WALKER P02-02", "WALKER P03-01", "WALKER P03-02"]);
  });

  it("means what it says: the plane number in a name is that satellite's plane, and the slot its position along it", () => {
    // The names are what a reader on the globe navigates by, so the two numbers have
    // to agree with the geometry rather than merely being sequential. Checked against
    // the elements: every satellite tagged P02 shares one RAAN, that RAAN is the
    // second one round the span, and the slot numbers rise with along-track position
    // inside the plane.
    const records = walkerDeltaRecords(minimal, EPOCH);
    const tagged = records.map((record) => {
      const omm = ommOf(record);
      const [, plane, slot] = /P(\d+)-(\d+)$/.exec(String(omm.OBJECT_NAME)) ?? [];
      return { plane: Number(plane), slot: Number(slot), raan: Number(omm.RA_OF_ASC_NODE), anomaly: Number(omm.MEAN_ANOMALY) };
    });

    const raanOfPlane = new Map<number, number[]>();
    for (const satellite of tagged) {
      raanOfPlane.set(satellite.plane, [...(raanOfPlane.get(satellite.plane) ?? []), satellite.raan]);
    }
    // One plane, one RAAN — a satellite named P02 is not in some other plane.
    for (const raans of raanOfPlane.values()) {
      expect(new Set(raans).size).toBe(1);
    }
    // And plane 1, 2, 3 are the first, second and third round the span, in order.
    expect([...raanOfPlane.keys()].toSorted((a, b) => a - b).map((plane) => raanOfPlane.get(plane)?.[0])).toEqual([0, 120, 240]);

    // Within a plane the slots ascend along-track from the first one.
    for (const plane of raanOfPlane.keys()) {
      const bySlot = tagged.filter((satellite) => satellite.plane === plane).toSorted((a, b) => a.slot - b.slot);
      const first = bySlot[0]?.anomaly ?? 0;
      const offsets = bySlot.map((satellite) => (satellite.anomaly - first + 360) % 360);
      expect(offsets).toEqual(offsets.toSorted((a, b) => a - b));
      expect(bySlot.map((satellite) => satellite.slot)).toEqual([1, 2]);
    }
  });

  it("reads the plane and slot back out of a generated name", () => {
    const records = walkerDeltaRecords(minimal, EPOCH);
    expect(records.map((record) => planeSlotOf(String(ommOf(record).OBJECT_NAME)))).toEqual(["P01-01", "P01-02", "P02-01", "P02-02", "P03-01", "P03-02"]);
    // The long real prefix a pattern actually generates under, not just the test one.
    expect(planeSlotOf(`${walkerNamePrefix(starlinkShell1)} P07-22`)).toBe("P07-22");
  });

  it("reports no plane or slot for a name that has none", () => {
    // A real catalogued satellite is not in a Walker pattern, so there is nothing to
    // report and the caller has to say something else. Anchored at the end of the
    // name, so a plane-slot-shaped fragment mid-name is not mistaken for the tag.
    expect(planeSlotOf("ISS (ZARYA)")).toBeUndefined();
    expect(planeSlotOf("STARLINK-1007")).toBeUndefined();
    expect(planeSlotOf("WALKER P01-01 DEB")).toBeUndefined();
    expect(planeSlotOf(undefined)).toBeUndefined();
    expect(planeSlotOf("")).toBeUndefined();
  });
});

describe("the records SGP4 makes of them", () => {
  it("round-trips inclination, RAAN and mean anomaly through a satrec", () => {
    const [record] = walkerDeltaRecords({ ...minimal, phasing: 0 }, EPOCH);
    const satrec = createSatrec(record!);
    expect(satrec.error).toBe(0);
    expect((satrec.inclo * 180) / Math.PI).toBeCloseTo(53, 6);
    expect((satrec.nodeo * 180) / Math.PI).toBeCloseTo(0, 6);
    expect((satrec.mo * 180) / Math.PI).toBeCloseTo(0, 6);
    expect(satrec.ecco).toBe(0);
  });

  it("propagates to the requested altitude within the J2 recovery offset", () => {
    const [record] = walkerDeltaRecords(starlinkShell1, EPOCH);
    const satrec = createSatrec(record!);
    const state = propagate(satrec, EPOCH);
    expect(state).not.toBeNull();
    const { x, y, z } = state!.position;
    const altitude = Math.sqrt(x * x + y * y + z * z) - constants.earthRadius;
    // Asked for 550 km. SGP4 recovers the semi-major axis from the Kozai mean
    // motion with J2 included, so the flown altitude sits a few km below it.
    expect(altitude).toBeGreaterThan(535);
    expect(altitude).toBeLessThan(555);
  });

  it("keeps every satellite on the same orbit, within the J2 short-period radius swing", () => {
    // e = 0 makes the pattern circular in the *mean* elements SGP4 is given, not
    // in the radius it flies: J2 varies the radius with the argument of latitude,
    // so satellites at different mean anomalies sit tens of km apart at one
    // instant. ~10 km at 550 km is that effect, not an eccentricity that leaked in
    // — the check is that nothing puts one satellite on a different shell.
    const records = walkerDeltaRecords(minimal, EPOCH);
    const altitudes = records.map((record) => {
      const state = propagate(createSatrec(record), EPOCH)!;
      const { x, y, z } = state.position;
      return Math.sqrt(x * x + y * y + z * z);
    });
    const spread = Math.max(...altitudes) - Math.min(...altitudes);
    expect(spread).toBeLessThan(30);
    // And every satrec agrees on the mean orbit exactly.
    const semiMajorAxes = new Set(records.map((record) => createSatrec(record).a.toFixed(9)));
    expect(semiMajorAxes.size).toBe(1);
  });

  it("classifies a 550 km shell as LEO and a 1200 km one as LEO too", () => {
    const [low] = walkerDeltaRecords(starlinkShell1, EPOCH);
    const [high] = walkerDeltaRecords({ ...minimal, altitudeKm: 1200 }, EPOCH);
    expect(orbitClassOf(low!)).toBe("LEO");
    expect(orbitClassOf(high!)).toBe("LEO");
  });

  it("puts the two satellites of a plane on opposite sides of the Earth", () => {
    const [first, second] = walkerDeltaRecords({ ...minimal, phasing: 0 }, EPOCH);
    const a = propagate(createSatrec(first!), EPOCH)!.position;
    const b = propagate(createSatrec(second!), EPOCH)!.position;
    const dot = a.x * b.x + a.y * b.y + a.z * b.z;
    const magnitudes = Math.sqrt(a.x ** 2 + a.y ** 2 + a.z ** 2) * Math.sqrt(b.x ** 2 + b.y ** 2 + b.z ** 2);
    expect(dot / magnitudes).toBeCloseTo(-1, 2);
  });

  it("produces a GMST the app can already turn into a ground position", () => {
    // Guards the epoch being a real ISO date rather than something json2satrec
    // silently reads as NaN: an unusable epoch would make gstime NaN here.
    const [record] = walkerDeltaRecords(minimal, EPOCH);
    const satrec = createSatrec(record!);
    expect(Number.isFinite(gstime(satrec.jdsatepoch))).toBe(true);
  });
});

describe("the wire form", () => {
  it("writes Walker's own notation", () => {
    expect(encodeWalker(starlinkShell1)).toBe("53:1584/72/17@550");
  });

  it("appends the span only when it is not a full Delta", () => {
    expect(encodeWalker({ ...minimal, raanSpanDeg: 180 })).toBe("53:6/3/1@550~180");
  });

  it("round-trips every preset", () => {
    for (const preset of WALKER_PRESETS) {
      expect(decodeWalker(encodeWalker(preset.params))).toEqual(preset.params);
    }
  });

  it("reads a fractional inclination and altitude back unchanged", () => {
    expect(decodeWalker("97.6:348/6/58@560.5")).toEqual({
      inclinationDeg: 97.6,
      total: 348,
      planes: 6,
      phasing: 58,
      altitudeKm: 560.5,
      raanSpanDeg: 360,
    });
  });

  it("rejects a malformed or unbuildable pattern rather than half-reading it", () => {
    expect(decodeWalker("")).toBeUndefined();
    expect(decodeWalker("53:1584/72/17")).toBeUndefined();
    expect(decodeWalker("53:7/3/1@550")).toBeUndefined();
    expect(decodeWalker("53:6/3/1@10")).toBeUndefined();
    expect(decodeWalker("nonsense")).toBeUndefined();
  });
});

describe("WALKER_PRESETS", () => {
  it("only offers patterns that build", () => {
    for (const preset of WALKER_PRESETS) {
      expect(validateWalkerDelta(preset.params).ok, preset.label).toBe(true);
      expect(walkerDeltaRecords(preset.params, EPOCH)).toHaveLength(preset.params.total);
    }
  });
});

describe("identity across patterns", () => {
  it("gives each pattern its own tag, recognisable as a generated one", () => {
    expect(walkerTagFor(minimal)).toBe("Walker 53:6/3/1@550");
    expect(isWalkerTag(walkerTagFor(minimal))).toBe(true);
    expect(isWalkerTag("Starlink")).toBe(false);
  });

  it("names every preset's satellites distinctly", () => {
    const prefixes = WALKER_PRESETS.map((preset) => walkerNamePrefix(preset.params));
    expect(new Set(prefixes).size).toBe(WALKER_PRESETS.length);
  });

  it("puts every preset in its own satnum band, clear of the NORAD catalog", () => {
    const bases = WALKER_PRESETS.map((preset) => walkerSatnumBase(preset.params));
    expect(new Set(bases).size).toBe(WALKER_PRESETS.length);
    for (const base of bases) {
      expect(base).toBeGreaterThanOrEqual(900000);
    }
  });

  it("keeps a pattern's satnums inside its own band", () => {
    const base = walkerSatnumBase(starlinkShell1);
    const satnums = walkerDeltaRecords(starlinkShell1, EPOCH, walkerNamePrefix(starlinkShell1), base).map((record) => Number(ommOf(record).NORAD_CAT_ID));
    expect(Math.min(...satnums)).toBe(base);
    expect(Math.max(...satnums)).toBeLessThan(base + MAX_WALKER_SATELLITES);
  });
});

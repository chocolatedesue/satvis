// The stable-link graph rules, checked against the derivation script's
// findings: rings are rigid, inter-plane same-slot links hold their identity,
// the Walker Star seam does not hold and is dropped, and different shells are
// never linked.
import { describe, expect, test } from "vitest";

import { constellationLinks, parseMarkToken, parseWalkerSatellite, planeRaanDeg, planesAgree, resolveMarks, wrapPlanesAgree, type LinkEndpoint } from "./constellationLinks";
import { resonantCompanion } from "./shellLayout";
import { encodeWalker, walkerNamePrefix, walkerPatternAt, type WalkerDeltaParams } from "./walkerDelta";

const DELTA: WalkerDeltaParams = { total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
const STAR: WalkerDeltaParams = { total: 66, planes: 6, phasing: 2, inclinationDeg: 86.4, altitudeKm: 780, raanSpanDeg: 180 };

/** The full active-satellite list a pattern generates, in the names the catalog sees. */
function fleet(params: WalkerDeltaParams): LinkEndpoint[] {
  const prefix = walkerNamePrefix(params);
  const perPlane = Math.round(params.total / params.planes);
  const out: LinkEndpoint[] = [];
  for (let plane = 0; plane < params.planes; plane += 1) {
    for (let slot = 0; slot < perPlane; slot += 1) {
      const parsed = parseWalkerSatellite(`${prefix} P${String(plane + 1).padStart(2, "0")}-${String(slot + 1).padStart(2, "0")}`);
      if (parsed) {
        out.push(parsed);
      }
    }
  }
  return out;
}

describe("parseWalkerSatellite", () => {
  test("reads the pattern and the plane-and-slot back out of a generated name", () => {
    const parsed = parseWalkerSatellite(`${walkerNamePrefix(DELTA)} P01-03`);
    expect(parsed).toMatchObject({ wire: "53:24/4/1@550", plane: 0, slot: 2 });
  });

  test("undefined for a real catalogued satellite", () => {
    expect(parseWalkerSatellite("ISS (ZARYA)")).toBeUndefined();
    expect(parseWalkerSatellite("W P01-01")).toBeUndefined();
  });
});

describe("planeRaanDeg", () => {
  test("spreads a Delta's planes evenly from its offset", () => {
    expect(planeRaanDeg(DELTA, 0)).toBe(0);
    expect(planeRaanDeg(DELTA, 2)).toBe(180);
    expect(planeRaanDeg({ ...DELTA, raanOffsetDeg: 270 }, 2)).toBe(90);
  });

  test("a Star spreads its planes over its own span", () => {
    expect(planeRaanDeg(STAR, 3)).toBe(90);
  });
});

describe("wrapPlanesAgree", () => {
  test("a full Delta wraps through the plane spacing itself", () => {
    expect(wrapPlanesAgree(DELTA)).toBe(true);
  });

  test("the Walker Star seam is counter-rotating and dropped", () => {
    expect(wrapPlanesAgree(STAR)).toBe(false);
  });
});

describe("parseMarkToken", () => {
  test("reads plane, slot and wire, 1-based", () => {
    expect(parseMarkToken("1-1@53:40/4/1@550")).toEqual({ plane: 0, slot: 0, wire: "53:40/4/1@550" });
    expect(parseMarkToken("4-6@53:24/4/1@550")).toEqual({ plane: 3, slot: 5, wire: "53:24/4/1@550" });
  });

  test("undefined for a malformed pair or an unknown pattern", () => {
    expect(parseMarkToken("1@53:24/4/1@550")).toBeUndefined();
    expect(parseMarkToken("a-b@53:24/4/1@550")).toBeUndefined();
    expect(parseMarkToken("1-1@nonsense")).toBeUndefined();
    expect(parseMarkToken("@53:24/4/1@550")).toBeUndefined();
  });
});

describe("resolveMarks", () => {
  test("resolves members by pattern, plane and slot, and bonds every pair", () => {
    const fleetMarks = fleet(DELTA);
    const tokens = ["1-1@53:24/4/1@550", "2-1@53:24/4/1@550", "3-1@53:24/4/1@550"];
    const { members, bonds } = resolveMarks(tokens, fleetMarks);
    expect(members).toHaveLength(3);
    // Three members, pairwise bonded: 3 choose 2.
    expect(bonds).toHaveLength(3);
  });

  test("a token whose satellite is not active contributes neither member nor bond", () => {
    const tokens = ["1-1@53:24/4/1@550", "99-99@53:24/4/1@550"];
    const { members, bonds } = resolveMarks(tokens, fleet(DELTA));
    expect(members).toHaveLength(1);
    expect(bonds).toHaveLength(0);
  });

  test("cross-shell tokens bond across patterns", () => {
    const higher: WalkerDeltaParams = { ...DELTA, altitudeKm: 1200 };
    const { bonds } = resolveMarks(["1-1@53:24/4/1@550", "1-1@53:24/4/1@1200"], [...fleet(DELTA), ...fleet(higher)]);
    expect(bonds).toHaveLength(1);
  });

  test("a bond carries the layout verdict its two orbits earn", () => {
    // Same shell: rigid, and the bond comes back every orbit.
    const withinShell = resolveMarks(["1-1@53:24/4/1@550", "2-1@53:24/4/1@550"], fleet(DELTA)).bonds[0];
    expect(withinShell).toMatchObject({ verdict: "rigid", returns: true });

    // The stacked-shells demo's two 1200 km shells: phases frozen, planes shearing.
    const seventy: WalkerDeltaParams = { ...DELTA, altitudeKm: 1200, inclinationDeg: 70 };
    const polar: WalkerDeltaParams = { ...DELTA, altitudeKm: 1200, inclinationDeg: 97.6 };
    const sameAltitude = resolveMarks(["1-1@70:24/4/1@1200", "1-1@97.6:24/4/1@1200"], [...fleet(seventy), ...fleet(polar)]).bonds[0];
    expect(sameAltitude).toMatchObject({ verdict: "phase-locked", returns: true });

    // A shell picked for its altitude alone: nothing about the pair repeats.
    const acrossShells = resolveMarks(["1-1@53:24/4/1@550", "1-1@97.6:24/4/1@1200"], [...fleet(DELTA), ...fleet(polar)]).bonds[0];
    expect(acrossShells).toMatchObject({ verdict: "drifting", returns: false });
  });

  test("a designed companion bonds as repeating, and holds", () => {
    const layout = resonantCompanion({ altitudeKm: 550, inclinationDeg: 53 }, 8, 7) as NonNullable<ReturnType<typeof resonantCompanion>>;
    const companion = walkerPatternAt(DELTA, layout, layout.minPerPlane) as WalkerDeltaParams;
    const { bonds } = resolveMarks([`1-1@${encodeWalker(DELTA)}`, `1-1@${encodeWalker(companion)}`], [...fleet(DELTA), ...fleet(companion)]);
    expect(bonds[0]).toMatchObject({ verdict: "repeating", returns: true });
  });
});

describe("constellationLinks", () => {
  test("a full Delta links every ring and every same-slot pair, wrap included", () => {
    const links = constellationLinks(fleet(DELTA));
    // 4 planes x 6 slots of intra links, 4 planes x 6 slots of inter links
    // (the wrap is plane 4 -> plane 1, a normal inter-plane pair in a Delta).
    expect(links.filter((l) => l.kind === "intra")).toHaveLength(24);
    expect(links.filter((l) => l.kind === "inter")).toHaveLength(24);
  });

  test("a Walker Star drops the seam but keeps the rest", () => {
    const links = constellationLinks(fleet(STAR));
    expect(links.filter((l) => l.kind === "intra")).toHaveLength(66);
    // 5 inter-plane gaps x 11 slots; the seam gap is not linked.
    expect(links.filter((l) => l.kind === "inter")).toHaveLength(55);
  });

  test("two shells are never linked to each other", () => {
    const higher: WalkerDeltaParams = { ...DELTA, altitudeKm: 1200 };
    const links = constellationLinks([...fleet(DELTA), ...fleet(higher)]);
    expect(links.filter((l) => l.kind === "intra")).toHaveLength(48);
    expect(links.filter((l) => l.kind === "inter")).toHaveLength(48);
    expect(links.filter((l) => l.kind === "bridge")).toHaveLength(0);
    for (const link of links) {
      const sameShell = link.a.split(" ")[0] === link.b.split(" ")[0];
      expect(sameShell).toBe(true);
    }
  });

  test("a node-locked companion is still two shells, and still unwired", () => {
    // Its schedule repeats; its partner does not. Only a frozen offset earns a link.
    const layout = resonantCompanion({ altitudeKm: 550, inclinationDeg: 53 }, 8, 7) as NonNullable<ReturnType<typeof resonantCompanion>>;
    const companion = walkerPatternAt(DELTA, layout, layout.minPerPlane) as WalkerDeltaParams;
    const links = constellationLinks([...fleet(DELTA), ...fleet(companion)]);
    expect(links.filter((l) => l.kind === "bridge")).toHaveLength(0);
  });

  test("two patterns at one altitude and inclination are bridged as the single shell they are", () => {
    // The sun-synchronous demo's shape: the same orbit twice, a quarter turn of
    // right ascension apart. Equal mean motion and equal node rate, so the offset
    // between them never moves — there is nothing an inter-plane link has that a
    // link across this pair lacks.
    const dawn: WalkerDeltaParams = { total: 6, planes: 2, phasing: 0, inclinationDeg: 97.6, altitudeKm: 1200, raanSpanDeg: 360 };
    const dusk: WalkerDeltaParams = { ...dawn, raanOffsetDeg: 90 };
    const links = constellationLinks([...fleet(dawn), ...fleet(dusk)]);
    const bridges = links.filter((l) => l.kind === "bridge");
    // Each of the two patterns' planes bridges to the one nearest it in RAAN, and
    // both slots of that plane pair are wired: 2 plane pairs x 3 slots.
    expect(bridges).toHaveLength(6);
    for (const bridge of bridges) {
      expect(bridge.a.split(" ")[0]).not.toBe(bridge.b.split(" ")[0]);
    }
  });

  test("a bridge across counter-rotating planes is dropped like any other", () => {
    // Two near-polar patterns 180° apart in RAAN: the planes oppose, and same-slot
    // satellites sweep past each other at twice orbital rate.
    const first: WalkerDeltaParams = { total: 4, planes: 1, phasing: 0, inclinationDeg: 89, altitudeKm: 1200, raanSpanDeg: 360 };
    const second: WalkerDeltaParams = { ...first, raanOffsetDeg: 180 };
    expect(planesAgree(89, 180)).toBe(false);
    expect(constellationLinks([...fleet(first), ...fleet(second)]).filter((l) => l.kind === "bridge")).toHaveLength(0);
  });

  test("a partial pattern links only what is flying, and the ring closes over it", () => {
    const prefix = walkerNamePrefix(DELTA);
    const present = [0, 1, 3, 4].flatMap((slot) => {
      const parsed = parseWalkerSatellite(`${prefix} P01-0${slot + 1}`);
      return parsed ? [parsed] : [];
    });
    const links = constellationLinks(present);
    // Active slots 0,1,3,4 close as ring 0-1, 1-3, 3-4, 4-0 — one ring, four links.
    expect(links.filter((l) => l.kind === "intra")).toHaveLength(4);
    expect(links.filter((l) => l.kind === "inter")).toHaveLength(0);
  });

  test("every link is undirected-unique", () => {
    const links = constellationLinks(fleet(DELTA));
    const keys = links.map((l) => [l.a, l.b].toSorted().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

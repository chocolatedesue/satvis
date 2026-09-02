// The stable-link graph rules, checked against the derivation script's
// findings: rings are rigid, inter-plane same-slot links hold their identity,
// the Walker Star seam does not hold and is dropped, and different shells are
// never linked.
import { describe, expect, test } from "vitest";

import { constellationLinks, parseMarkToken, parseWalkerSatellite, resolveMarks, wrapPlanesAgree, type LinkEndpoint } from "./constellationLinks";
import { walkerNamePrefix, type WalkerDeltaParams } from "./walkerDelta";

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

  test("two patterns are never linked to each other", () => {
    const higher: WalkerDeltaParams = { ...DELTA, altitudeKm: 1200 };
    const links = constellationLinks([...fleet(DELTA), ...fleet(higher)]);
    expect(links.filter((l) => l.kind === "intra")).toHaveLength(48);
    expect(links.filter((l) => l.kind === "inter")).toHaveLength(48);
    for (const link of links) {
      const sameShell = link.a.split(" ")[0] === link.b.split(" ")[0];
      expect(sameShell).toBe(true);
    }
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

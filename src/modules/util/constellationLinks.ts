// The stable inter-satellite link pattern for generated Walker fleets, as a
// pure link graph over satellite names.
//
// "Stable" is the operative word, and it is a derived result, not a taste:
// scripts/derive-isl-topology.mjs flies the patterns with SGP4 and scores every
// candidate wiring on link-length discipline (how far a link stretches over an
// orbit) and identity stability (how often the nearest neighbour changes). The
// rules below are what survived:
//
// - **Intra-plane rings.** Satellites in one plane link to their ring
//   neighbours. Equal periods keep the spacing exact, so these links never
//   change length by more than a part in a thousand — the one family that is
//   rigid by construction rather than by effort. (Whether the chord clears the
//   Earth is a fleet-design question, not a wiring one: at 550 km a ring needs
//   S ≥ 8 satellites per plane, at 1200 km S ≥ 6, or the chord passes through
//   the ground — the derivation script prints the threshold.)
//
// - **Same-slot links between adjacent planes.** Plane p's slot s links to
//   plane p+1's slot s. Both advance along their orbits at the same rate, so
//   the along-track offset between the pair is constant forever — the link
//   breathes with the plane geometry (CV ~0.14–0.27) but its endpoints never
//   re-wire. This is the Iridium inter-plane pattern.
//
// - **No wrap link across counter-rotating planes.** When the wrap gap closes
//   the RAAN ring past antipodal (the Walker Star seam), the two planes' orbit
//   normals oppose and same-slot satellites sweep past each other at twice
//   orbital rate: link length swings 1.5–14 thousand km (CV 0.74) and identity
//   churn triples. Iridium closes its seam for exactly this reason; so does
//   this graph. The test is the dot product of the two planes' orbit normals —
//   same hemisphere, keep; opposed, drop.
//
// - **Between patterns, only where the pair is rigid.** Two different Walker
//   patterns are usually different shells: unless their altitudes coincide the
//   periods differ, the along-track offset drifts monotonically, and the nearest
//   satellite across the shells changes forever (measured churn 0.20 per sample,
//   never settling). The exception `./shellLayout.ts` names is a pair that shares
//   an altitude *and* an inclination — equal mean motion and equal node rate, so
//   every offset between them is frozen. That is not two shells, it is one shell
//   flown as two patterns (a second RAAN offset, a phased sub-constellation), and
//   it is wired as one: each plane bridges to the nearest plane of the other
//   pattern, same slot, subject to the same counter-rotation test the wrap link
//   gets. Everything else — including a node-locked, resonant companion, whose
//   *schedule* repeats but whose partner does not — stays unwired.
//
// The graph is rebuilt from whatever subset of each pattern is currently
// active: a pattern with missing satellites links the ones it has, closing the
// ring over the active slots rather than the nominal ones.

import { configurationReturns, shellPairLayout, type ShellPairVerdict } from "./shellLayout";
import { decodeWalker, type WalkerDeltaParams } from "./walkerDelta";

/** One end of a link: the satellite's catalog name plus where it sits in its pattern. */
export interface LinkEndpoint {
  name: string;
  /** The pattern's wire form (`i:T/P/F@alt`, with optional `~span` and `+offset`). */
  wire: string;
  /** 0-based plane index within the pattern. */
  plane: number;
  /** 0-based slot index along the plane. */
  slot: number;
}

/**
 * One undirected link between two active satellites.
 *
 * `intra` runs round a plane's ring, `inter` between neighbouring planes of one
 * pattern, and `bridge` between two patterns that share an altitude and an
 * inclination — the one cross-pattern case whose geometry is frozen rather than
 * merely bounded (`./shellLayout.ts`, verdict `rigid`).
 */
export interface SatelliteLink {
  kind: "intra" | "inter" | "bridge";
  a: string;
  b: string;
}

/**
 * One member of a marked cluster: the satellite's catalog name plus where it
 * sits in its pattern.
 */

/**
 * The marked-cluster selector grammar: `<plane>-<slot>@<wire>`, planes and
 * slots 1-based to match the `P01-01` labels on screen. The wire is the
 * pattern's own `i:T/P/F@alt` form, so a token names a satellite across every
 * view and every share link without depending on pattern ordering:
 * `1-1@53:40/4/1@550` is plane 1, slot 1 of the 40-satellite 550 km shell.
 * Split on the first `@` - the plane-slot pair never contains one, the wire
 * contains exactly one.
 */
export function parseMarkToken(token: string): { plane: number; slot: number; wire: string } | undefined {
  const at = token.indexOf("@");
  if (at <= 0) {
    return undefined;
  }
  const pair = /^([0-9]+)-([0-9]+)$/.exec(token.slice(0, at));
  if (!pair) {
    return undefined;
  }
  const wire = token.slice(at + 1);
  if (!decodeWalker(wire)) {
    return undefined;
  }
  return { plane: Number(pair[1]) - 1, slot: Number(pair[2]) - 1, wire };
}

/**
 * Resolve marked tokens against the active generated satellites, and bond every
 * marked pair to every other.
 *
 * The bonds are the point of marking: the auto-topology links a satellite only
 * to its own plane and its neighbouring planes, but a marked cluster is allowed
 * to span shells - a same-slot satellite from each of three different shells,
 * bonded pairwise, is exactly the small fleet whose slow shear a viewer wants
 * to watch. Bonds are drawn between present members only; a token whose
 * satellite is not currently active simply contributes no member and no bond,
 * and joins in the moment its satellite is switched back on.
 */
export interface MarkedBond {
  a: string;
  b: string;
  /**
   * What the two members' orbits do to each other, from `./shellLayout.ts`:
   * `rigid`, `repeating`, `phase-locked`, `node-locked` or `drifting`. Carried
   * whole because it is the verdict the cluster exists to test, and a reader who
   * hovers the bond deserves the word rather than the bit.
   */
  verdict: ShellPairVerdict;
  /**
   * Whether that verdict is one whose geometry comes back — solid versus dashed,
   * because that is the one distinction a line style can carry. A same-period
   * pair holds its distance envelope every orbit; a node-locked or drifting one
   * slides through its synodic cycle without ever settling.
   */
  returns: boolean;
}

export function resolveMarks(tokens: readonly string[], satellites: readonly LinkEndpoint[]): { members: LinkEndpoint[]; bonds: MarkedBond[] } {
  const byIdentity = new Map<string, LinkEndpoint>();
  for (const satellite of satellites) {
    byIdentity.set(`${satellite.wire}#${satellite.plane}#${satellite.slot}`, satellite);
  }
  const members: LinkEndpoint[] = [];
  for (const token of tokens) {
    const mark = parseMarkToken(token);
    if (!mark) {
      continue;
    }
    const member = byIdentity.get(`${mark.wire}#${mark.plane}#${mark.slot}`);
    if (member) {
      members.push(member);
    }
  }
  const orbitOf = new Map(members.map((member) => [member.name, decodeWalker(member.wire)]));
  const bonds: MarkedBond[] = [];
  for (let a = 0; a < members.length; a += 1) {
    for (let b = a + 1; b < members.length; b += 1) {
      const first = orbitOf.get(members[a]!.name);
      const second = orbitOf.get(members[b]!.name);
      // A member whose wire will not decode has no orbit to compare, so the bond
      // claims nothing: drawn, dashed, and honest about knowing nothing.
      const verdict: ShellPairVerdict = first && second ? shellPairLayout(first, second).verdict : "drifting";
      bonds.push({ a: members[a]!.name, b: members[b]!.name, verdict, returns: configurationReturns(verdict) });
    }
  }
  return { members, bonds };
}

/**
 * The plane-and-slot identity of a generated satellite, read out of its name.
 *
 * `walkerDeltaRecords` names every satellite `<pattern prefix> P01-03`, and
 * `planeSlotOf` reads the tail back. This goes one step further and also
 * recovers the pattern itself, which the prefix carries as `W<wire>` — so a
 * link graph can be built from the active satellite list alone, with no
 * reference to the store that generated it. Undefined for anything that is not
 * a generated satellite (a real catalogued satellite has no plane or slot, and
 * `ISS (ZARYA)` is not about to join a topology).
 */
export function parseWalkerSatellite(name: string): LinkEndpoint | undefined {
  const match = /^W(.+) P(\d+)-(\d+)$/.exec(name);
  if (!match) {
    return undefined;
  }
  const [, wire, plane, slot] = match;
  if (wire === undefined || plane === undefined || slot === undefined || !decodeWalker(wire)) {
    return undefined;
  }
  return { name, wire, plane: Number(plane) - 1, slot: Number(slot) - 1 };
}

/**
 * Whether two orbit planes of the same inclination, `gapDeg` of right ascension
 * apart, circulate the same way.
 *
 * The orbit normal of a plane at RAAN Ω and inclination i is
 * `(sinΩ·sin i, −cosΩ·sin i, cos i)`, so two planes ΔΩ apart have
 * `sin²i·cos ΔΩ + cos²i` between their normals: positive means satellites in the
 * two planes circulate the same way (constant along-track offsets, stable
 * same-slot links); negative means they sweep past each other at twice orbital
 * rate — the Walker Star seam, and no place for a link.
 */
export function planesAgree(inclinationDeg: number, gapDeg: number): boolean {
  const radians = (gapDeg * Math.PI) / 180;
  const inclination = (inclinationDeg * Math.PI) / 180;
  return Math.sin(inclination) ** 2 * Math.cos(radians) + Math.cos(inclination) ** 2 > 0;
}

/** Where a pattern's plane sits in absolute right ascension. */
export function planeRaanDeg(params: WalkerDeltaParams, plane: number): number {
  const raan = (params.raanOffsetDeg ?? 0) + (plane * params.raanSpanDeg) / params.planes;
  return ((raan % 360) + 360) % 360;
}

/** The right-ascension gap between two planes, the short way round: 0° to 180°. */
function raanGapDeg(first: number, second: number): number {
  const gap = Math.abs(((first - second) % 360) + 360) % 360;
  return gap > 180 ? 360 - gap : gap;
}

/**
 * Whether the wrap pair of planes (last to first) rotates the same way.
 *
 * The orbit normal of a plane at RAAN Ω and inclination i is
 * `(sinΩ·sin i, −cosΩ·sin i, cos i)`, so two planes RAAN gap ΔΩ apart have
 * `sin²i·cos ΔΩ + cos²i` between their normals: positive means satellites in
 * the two planes circulate the same way (constant along-track offsets, stable
 * same-slot links); negative means they sweep past each other at twice orbital
 * rate (the Walker Star seam — drop the link).
 *
 * `wrapGapDeg` is the RAAN from the last plane to the first the long way round:
 * `360 − span + span/P`. For a full Delta this collapses to the plane spacing
 * itself, so the wrap link is the same as any other inter-plane link.
 */
export function wrapPlanesAgree(params: WalkerDeltaParams): boolean {
  return planesAgree(params.inclinationDeg, 360 - params.raanSpanDeg + params.raanSpanDeg / params.planes);
}

/**
 * The stable link graph over the given generated satellites.
 *
 * Satellites are grouped by their pattern (the wire in the name), so two
 * different shells are never linked: different periods mean the along-track
 * offset drifts forever and no fixed pairing can hold. Within a pattern the
 * graph is the ring in every plane plus same-slot links from each plane to the
 * next, with the wrap link kept only when `wrapPlanesAgree` says the last plane
 * circulates the same way as the first.
 *
 * Only links whose both endpoints are in the input are produced — a pattern
 * flying with half its slots empty links what is actually there.
 */
export function constellationLinks(satellites: readonly LinkEndpoint[]): SatelliteLink[] {
  const byPattern = new Map<string, Map<number, Map<number, string>>>();
  for (const satellite of satellites) {
    let planes = byPattern.get(satellite.wire);
    if (!planes) {
      planes = new Map();
      byPattern.set(satellite.wire, planes);
    }
    let slots = planes.get(satellite.plane);
    if (!slots) {
      slots = new Map();
      planes.set(satellite.plane, slots);
    }
    slots.set(satellite.slot, satellite.name);
  }

  const links: SatelliteLink[] = [];
  for (const [wire, planes] of byPattern) {
    const params = decodeWalker(wire);
    if (!params) {
      continue;
    }
    for (const [plane, slots] of planes) {
      const active = slots
        .keys()
        .toArray()
        .toSorted((a, b) => a - b);
      // The ring closes over the slots that are actually flying, so a partial
      // pattern still reads as a ring rather than as a ring with holes.
      if (active.length === 2) {
        const a = slots.get(active[0]!);
        const b = slots.get(active[1]!);
        if (a !== undefined && b !== undefined) {
          links.push({ kind: "intra", a, b });
        }
      } else {
        for (let at = 0; at < active.length; at += 1) {
          const a = slots.get(active[at]!);
          const b = slots.get(active[(at + 1) % active.length]!);
          if (a !== undefined && b !== undefined) {
            links.push({ kind: "intra", a, b });
          }
        }
      }
      const nextPlane = planes.get(plane + 1);
      if (nextPlane) {
        for (const [slot, name] of slots) {
          const other = nextPlane.get(slot);
          if (other !== undefined) {
            links.push({ kind: "inter", a: name, b: other });
          }
        }
      }
    }
    if (wrapPlanesAgree(params) && planes.size === params.planes) {
      const first = planes.get(0);
      const last = planes.get(params.planes - 1);
      if (first && last) {
        for (const [slot, name] of last) {
          const other = first.get(slot);
          if (other !== undefined) {
            links.push({ kind: "inter", a: name, b: other });
          }
        }
      }
    }
  }
  links.push(...bridgeLinks(byPattern));
  return links;
}

/**
 * The links between patterns that are the same shell in two pieces.
 *
 * Two patterns at the same altitude and the same inclination have the same mean
 * motion and the same J₂ node rate, so every offset between them — along-track
 * and in right ascension — is frozen for good (`./shellLayout.ts` calls the pair
 * `rigid`). There is then nothing to distinguish a link across the pair from an
 * inter-plane link inside one of them, and the fleet is wired as the one shell it
 * is: each plane to the plane of the other pattern nearest it in right ascension,
 * same slot, dropped when the two planes counter-rotate.
 *
 * Nearest rather than every pair, because a shell's inter-plane links go to
 * neighbours: linking every plane of A to every plane of B would wire the far
 * side of the sky to the near one and call the resulting thicket a topology.
 *
 * Nothing here fires for the ordinary two-shell case — different altitudes are
 * different periods, and no fixed wiring survives that. What it does fire for is
 * the case the old "nothing between patterns" rule got wrong: the sun-synchronous
 * demo's dawn–dusk and noon–midnight planes, or any pattern generated a second
 * time at another RAAN offset.
 */
function bridgeLinks(byPattern: Map<string, Map<number, Map<number, string>>>): SatelliteLink[] {
  const families = new Map<string, string[]>();
  for (const wire of byPattern.keys()) {
    const params = decodeWalker(wire);
    if (!params) {
      continue;
    }
    const key = `${params.altitudeKm}#${params.inclinationDeg}`;
    const family = families.get(key);
    if (family) {
      family.push(wire);
    } else {
      families.set(key, [wire]);
    }
  }
  const links: SatelliteLink[] = [];
  const wired = new Set<string>();
  for (const wires of families.values()) {
    if (wires.length < 2) {
      continue;
    }
    for (let a = 0; a < wires.length; a += 1) {
      for (let b = a + 1; b < wires.length; b += 1) {
        const here = decodeWalker(wires[a]!);
        const there = decodeWalker(wires[b]!);
        const herePlanes = byPattern.get(wires[a]!);
        const therePlanes = byPattern.get(wires[b]!);
        if (!here || !there || !herePlanes || !therePlanes) {
          continue;
        }
        for (const [plane, slots] of herePlanes) {
          let nearest: number | undefined;
          let nearestGap = Infinity;
          for (const other of therePlanes.keys()) {
            const gap = raanGapDeg(planeRaanDeg(here, plane), planeRaanDeg(there, other));
            if (gap < nearestGap) {
              nearestGap = gap;
              nearest = other;
            }
          }
          if (nearest === undefined || !planesAgree(here.inclinationDeg, nearestGap)) {
            continue;
          }
          const key = `${wires[a]}#${plane}|${wires[b]}#${nearest}`;
          if (wired.has(key)) {
            continue;
          }
          wired.add(key);
          for (const [slot, name] of slots) {
            const other = therePlanes.get(nearest)?.get(slot);
            if (other !== undefined) {
              links.push({ kind: "bridge", a: name, b: other });
            }
          }
        }
      }
    }
  }
  return links;
}

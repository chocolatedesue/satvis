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
// - **Nothing between patterns.** Two different Walker patterns are different
//   shells; unless their altitudes coincide the periods differ, the along-track
//   offset drifts monotonically, and the nearest satellite across the shells
//   changes forever (measured churn 0.20 per sample, never settling). Each
//   pattern is linked within itself and left there.
//
// The graph is rebuilt from whatever subset of each pattern is currently
// active: a pattern with missing satellites links the ones it has, closing the
// ring over the active slots rather than the nominal ones.

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

/** One undirected link between two active satellites. */
export interface SatelliteLink {
  kind: "intra" | "inter";
  a: string;
  b: string;
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
  const wrapGapDeg = 360 - params.raanSpanDeg + params.raanSpanDeg / params.planes;
  const radians = (wrapGapDeg * Math.PI) / 180;
  const inclination = (params.inclinationDeg * Math.PI) / 180;
  const dot = Math.sin(inclination) ** 2 * Math.cos(radians) + Math.cos(inclination) ** 2;
  return dot > 0;
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
      const active = slots.keys().toArray().toSorted((a, b) => a - b);
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
  return links;
}

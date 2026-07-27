import { DEFAULT_CONE_FOV_DEG, DEFAULT_SWATH_KM } from "../config/satelliteMetadata";
import Orbit, { type SwathExtents } from "./Orbit";
import { PassPredictor } from "./PassPredictor";
import { SampledTrajectory } from "./SampledTrajectory";
import type { CatalogEntry } from "./SatelliteCatalog";

export class SatelliteProperties {
  // The catalog owns identity and tag merging; properties read through it.
  entry: CatalogEntry;

  name: string;

  orbit: Orbit;

  satnum: string;

  // Owns all pass prediction state (ground stations, mode, computed passes).
  readonly passPredictor: PassPredictor;

  // Owns the sampled position window (fixed/inertial frames, gap-filling).
  readonly trajectory: SampledTrajectory;

  constructor(entry: CatalogEntry) {
    this.entry = entry;
    this.name = entry.name;
    this.satnum = entry.satnum;
    this.orbit = new Orbit(entry.name, entry.record);
    this.passPredictor = new PassPredictor(this.orbit, () => this.swathExtents);
    this.trajectory = new SampledTrajectory(this.orbit);
  }

  // Tags are owned by the catalog entry; this getter reflects live merges.
  get tags(): string[] {
    return this.entry.tags;
  }

  hasTag(tag: string): boolean {
    return this.tags.includes(tag);
  }

  // Per-side cross-track swath extents (km), from the record's metadata (see
  // src/config/satelliteMetadata.ts). The two sides are stored and validated as a
  // pair, so either both are present or the satellite has no extents of its own
  // and falls back to a symmetric split of the default total.
  get swathExtents(): SwathExtents {
    const { swathStarboardKm, swathPortKm } = this.entry.metadata;
    if (swathStarboardKm !== undefined && swathPortKm !== undefined) {
      return { starboardKm: swathStarboardKm, portKm: swathPortKm };
    }
    return { starboardKm: DEFAULT_SWATH_KM / 2, portKm: DEFAULT_SWATH_KM / 2 };
  }

  // Total swath width (km) — the sum of the two sides. This is what the symmetric
  // ground-track corridor is drawn with, and what the passes table reports; pass
  // containment itself uses the sides individually (see Orbit.computePassesSwath).
  get swath(): number {
    const { starboardKm, portKm } = this.swathExtents;
    return starboardKm + portKm;
  }

  // Sensor-cone half-angle FOV (degrees).
  get coneFovDeg(): number {
    return this.entry.metadata.coneFovDeg ?? DEFAULT_CONE_FOV_DEG;
  }
}

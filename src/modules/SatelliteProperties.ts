import type { OrbitClass } from "../config/orbitClass";
import { DEFAULT_CONE_FOV_DEG, DEFAULT_SWATH_KM, swathExtentsOf, type SatelliteMetadata, type SwathExtents } from "../config/satelliteMetadata";
import Orbit from "./Orbit";
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

  // Static per-satellite facts carried by this satellite's record. Fronted here so
  // callers reach them through the properties object they already hold rather than
  // walking down to the catalog entry.
  get metadata(): SatelliteMetadata {
    return this.entry.metadata;
  }

  // The orbit's regime. Decides the point's colour and gates the ground track
  // and sensor cone (see satelliteGraphics.isLeo).
  get orbitClass(): OrbitClass {
    return this.entry.orbitClass;
  }

  // Per-side cross-track swath extents (km). A satellite with no extents of its
  // own falls back to a symmetric split of the default total.
  get swathExtents(): SwathExtents {
    return swathExtentsOf(this.metadata) ?? { starboardKm: DEFAULT_SWATH_KM / 2, portKm: DEFAULT_SWATH_KM / 2 };
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
    return this.metadata.coneFovDeg ?? DEFAULT_CONE_FOV_DEG;
  }
}

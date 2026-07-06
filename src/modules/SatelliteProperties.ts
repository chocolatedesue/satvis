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
    this.passPredictor = new PassPredictor(this.orbit, () => this.swath);
    this.trajectory = new SampledTrajectory(this.orbit);
  }

  // Tags are owned by the catalog entry; this getter reflects live merges.
  get tags(): string[] {
    return this.entry.tags;
  }

  hasTag(tag: string): boolean {
    return this.tags.includes(tag);
  }

  // Swath width (km), resolved from catalog metadata rules (see
  // src/config/satelliteMetadata.ts). Resolution always populates swathKm from
  // the app defaults, so this is a plain read (no inline fallback).
  get swath(): number {
    return this.entry.metadata.swathKm;
  }

  // Sensor-cone half-angle FOV (degrees), resolved from catalog metadata rules.
  // Always populated by resolution's defaults, so a plain read.
  get coneFovDeg(): number {
    return this.entry.metadata.coneFovDeg;
  }
}

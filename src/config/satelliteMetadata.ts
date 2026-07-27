// Per-satellite metadata: the static facts a served GP record carries alongside
// its element set, attached by the worker at refresh time from the satellite
// table in worker/src/config/satvis.core.yaml (and plugin configs).
//
// The worker treats the bag as opaque and only copies it, so this file is the
// single place where it acquires meaning. Adding a field here plus a value in the
// YAML is the whole change — no worker or pipeline code is involved.
//
// This module must stay Cesium-free (node-env vitest exercises it).

// Static facts about one satellite. Every field is optional: a record either
// carries a value or the consumer applies its own default (see the DEFAULT_*
// constants below and SatelliteProperties).
export interface SatelliteMetadata {
  // Cross-track distance (km) from the ground track to the swath edge, per side,
  // relative to flight direction (starboard = velocity bearing + 90°). NOT
  // halves of a full width — the sides can differ, e.g. Sentinel-3's SLSTR is
  // tilted against sunglint. Given for both sides or neither (the generator
  // rejects a half-specified swath), so consumers read them as a pair.
  swathStarboardKm?: number;
  swathPortKm?: number;
  coneFovDeg?: number;
  modelUrl?: string;
  // Display-only, free text, shown verbatim in the entity info panel.
  operator?: string;
  missionType?: string;
}

// Total swath width for a satellite with no extents of its own. Kept as a total
// rather than a pair of per-side halves so "200 km wide by default" is stated
// once, and a half-specified swath cannot arise here either.
export const DEFAULT_SWATH_KM = 200;

export const DEFAULT_CONE_FOV_DEG = 10;

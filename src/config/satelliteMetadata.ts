// Per-satellite metadata, externalized from the old hardcoded swath table in
// SatelliteProperties. Resolution lives in SatelliteCatalog (Cesium-free): it
// starts from `defaults`, then shallow-merges the `metadata` of every matching
// rule in order (app rules first, then remote rules appended by
// mergeMetadataConfig — remote wins field-wise).
//
// This module must stay Cesium-free (node-env vitest exercises it).

// Extensible bag of per-satellite metadata. All fields optional; consumers
// fall back to hardcoded defaults when a field is absent.
export interface SatelliteMetadata {
  swathKm?: number;
  coneFovDeg?: number;
  modelUrl?: string;
}

// A rule matches a satellite by exact satnums, exact names, or a name pattern
// (RegExp tested against the name — mirrors the worker's group-select
// semantics). The old `includes()` substrings translate to identical literal
// regexes. When a rule matches, its `metadata` is shallow-merged over the
// accumulated result.
export interface MetadataRule {
  match: {
    satnums?: string[];
    names?: string[];
    namePattern?: string;
  };
  metadata: SatelliteMetadata;
}

export interface MetadataConfig {
  defaults: SatelliteMetadata;
  rules: MetadataRule[];
}

// Exact translation of the previous hardcoded swath getter:
//   ["SUOMI NPP", "NOAA 20 (JPSS-1)", "NOAA 21 (JPSS-2)"] -> 3000
//   ["AQUA", "TERRA"] -> 2330
//   includes("SENTINEL-2") -> 290
//   includes("SENTINEL-3") -> 740
//   includes("LANDSAT") -> 185
//   includes("FENGYUN") -> 2900
//   includes("METOP") -> 2900
//   default -> 200 (swath), 10 (cone fov)
export const appMetadataConfig: MetadataConfig = {
  defaults: { swathKm: 200, coneFovDeg: 10 },
  rules: [
    { match: { names: ["SUOMI NPP", "NOAA 20 (JPSS-1)", "NOAA 21 (JPSS-2)"] }, metadata: { swathKm: 3000 } },
    { match: { names: ["AQUA", "TERRA"] }, metadata: { swathKm: 2330 } },
    { match: { namePattern: "SENTINEL-2" }, metadata: { swathKm: 290 } },
    { match: { namePattern: "SENTINEL-3" }, metadata: { swathKm: 740 } },
    { match: { namePattern: "LANDSAT" }, metadata: { swathKm: 185 } },
    { match: { namePattern: "FENGYUN" }, metadata: { swathKm: 2900 } },
    { match: { namePattern: "METOP" }, metadata: { swathKm: 2900 } },
  ],
};

// Per-satellite metadata, externalized from the old hardcoded swath table in
// SatelliteProperties. Resolution lives in SatelliteCatalog (Cesium-free): it
// starts from `defaults`, then shallow-merges the `metadata` of every matching
// rule in order (app rules first, then remote rules appended by
// mergeMetadataConfig — remote wins field-wise).
//
// This module must stay Cesium-free (node-env vitest exercises it). A type-only
// import from worker/ is fine — it is erased at build and carries no runtime dep.

import type { MetadataRule as WireMetadataRule } from "../../worker/src/gp/types";

// Extensible bag of per-satellite metadata. All fields optional at the rule
// level; resolution guarantees the defaulted fields (see ResolvedMetadata).
export interface SatelliteMetadata {
  swathKm?: number;
  coneFovDeg?: number;
  modelUrl?: string;
}

// The result of resolving metadata for a satellite. The fields covered by
// `appMetadataConfig.defaults` are always present, so consumers read them
// without a fallback. Keep this in sync with the `defaults` shape below: the
// Required<Pick<...>> and the `defaults: ResolvedMetadata` typing pin the two
// together, so a field added to one without the other fails to compile.
export type ResolvedMetadata = SatelliteMetadata & Required<Pick<SatelliteMetadata, "swathKm" | "coneFovDeg">>;

// A rule matches a satellite by exact satnums, exact names, or a name pattern
// (RegExp tested against the name — mirrors the worker's group-select
// semantics). The old `includes()` substrings translate to identical literal
// regexes. When a rule matches, its `metadata` is shallow-merged over the
// accumulated result.
//
// The wire `match` shape is single-sourced from the worker; only the payload
// type narrows (the worker treats `metadata` as opaque, the frontend interprets
// it as SatelliteMetadata).
export type MetadataRule = Omit<WireMetadataRule, "metadata"> & { metadata: SatelliteMetadata };

export interface MetadataConfig {
  // Typed as ResolvedMetadata so the compiler enforces that defaults cover
  // exactly the fields resolution promises to always populate.
  defaults: ResolvedMetadata;
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

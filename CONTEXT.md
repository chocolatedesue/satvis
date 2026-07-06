# Domain glossary

Terms with a precise meaning in this codebase. Use these names in code and
discussion; sharpen them here when they drift.

- **Satellite**: one orbiting object, identified by a catalog entry
  (satnum + name) built from a GP element set (OMM or TLE).
- **Catalog**: the deduplicated registry of satellites across all loaded
  groups, with tag merging and metadata resolution (`SatelliteCatalog`).
- **Group**: a named, declaratively-configured list of element sets served as
  one unit (`/api/gp/<group>.json` or the static snapshot).
- **Ground station**: a named position on the ground that passes are computed
  against.
- **Pass**: a time range in which a satellite serves a ground station — by
  line-of-sight elevation ("elevation" mode) or sensor footprint overlap
  ("swath" mode).
- **Pass predictor**: the single owner of pass prediction for one satellite:
  ground stations, overpass mode, the recompute window guard, the computed
  pass list, and its Cesium time intervals (`PassPredictor`).
- **Overpass mode**: how passes are computed — "elevation" or "swath".
- **Sampled trajectory**: the sliding sample window of a satellite's position
  (half an orbit back, 1.5 forward) in both the fixed and inertial frames,
  kept fresh as time advances (`SampledTrajectory`).
- **Group store**: the persistence seam of the GP refresh pipeline —
  readIndex/writeGroup/writeIndex — with a Workers KV adapter (cron/API) and
  a disk adapter (static `data/gp/` snapshot) (`worker/src/gp/store.ts`).

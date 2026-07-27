# Domain glossary

Terms with a precise meaning in this codebase. Use these names in code and
discussion; sharpen them here when they drift.

- **Satellite**: one orbiting object, identified by a catalog entry
  (satnum + name) built from a GP element set (OMM or TLE).
- **Catalog**: the deduplicated registry of satellites across all loaded
  groups, with tag merging (`SatelliteCatalog`). Metadata is not resolved here —
  it arrives attached to the record.
- **Group**: a named, declaratively-configured list of element sets served as
  one unit (`/api/gp/<group>.json` or the static snapshot). A group decides what
  is served and under which name, never what is true of a satellite: per-satellite
  facts live in the satellite table, which is independent of any group.
- **Satellite table**: the registry of static per-satellite facts, identified by
  NORAD id and independent of the groups that serve those satellites. One table,
  merged from every config that contributes to it, so a fact is stated once no
  matter how many groups carry the satellite
  (`worker/src/config/satvis.core.yaml`).
- **Satellite metadata**: the bag of static facts the worker attaches to a served
  GP record at refresh time, from the satellite table. Opaque to the worker,
  interpreted by the frontend (`src/config/satelliteMetadata.ts`). A satellite
  absent from the table carries no metadata and falls back to app defaults.
- **Swath extent**: the cross-track distance from the ground track to the edge of
  a sensor's footprint, held per side (starboard = velocity bearing + 90°). Not
  half a width: the sides differ when a sensor is tilted, so a swath is a pair of
  extents, and their sum is the total width.
- **Orbit class**: the orbit's regime — LEO, MEO, GEO or HEO — derived from the
  element set, never configured, so every satellite has one and it cannot
  contradict its own orbit (`Orbit.orbitClass`).
- **Tag**: a label attached to satellites by the group that supplied them, and
  the unit the user activates ("enable Weather"). One satellite may carry tags
  from several groups. Tag names must not contain a comma.
- **Component**: one visual representation of a satellite that can be switched
  on independently — point, label, orbit, orbit track, ground track, sensor
  cone, 3D model. Component names must not contain a comma.
- **Activation**: which catalog entries should currently exist as live
  satellites — tag-enabled entries minus per-satellite opt-outs, plus
  name-enabled entries, plus the tracked satellite. Carried as three lists
  (enabled tags, enabled satellites, disabled satellites) that are only
  meaningful together: none of them can be validated without the other two
  (`src/modules/satelliteActivation.ts`).
- **Ground station**: a named position on the ground that passes are computed
  against.
- **Tracked satellite**: the satellite the camera follows. At most one, and the
  only value the globe reports back rather than merely receiving. Mutually
  exclusive with the sky view, which owns the camera itself: while the sky view
  is the active view mode nothing is tracked, and any attempt to track is
  undone.
- **Observer**: the point on the ground the sky view looks up from — the first
  ground station. Not a separate location: whoever the observer is, passes are
  already computed against them. It must be resolved before the sky view can
  open; where there is no ground station yet, the device's own location becomes
  one, and the sky view does not open if that is refused.
- **Pass**: a time range in which a satellite serves a ground station — by
  line-of-sight elevation ("elevation" mode) or sensor footprint overlap
  ("swath" mode). In swath mode which side of the ground track the station lies on
  matters, because a tilted sensor reaches further one way than the other.
- **Pass predictor**: the single owner of pass prediction for one satellite:
  ground stations, overpass mode, the recompute window guard, the computed
  pass list, and its Cesium time intervals (`PassPredictor`).
- **Overpass mode**: how passes are computed — "elevation" or "swath".
- **View mode**: where the viewer looks at the world from, and in what
  projection — the globe in 3D, 2D or Columbus, or the sky from a point on the
  ground. Exactly one is active. The app's own vocabulary, not Cesium's: three
  of the four coincide with a Cesium scene mode and the sky view does not
  (`src/config/viewModes.ts`).
- **Camera mode**: the reference frame the camera is pinned to — earth-fixed or
  inertial. Independent of the view mode.
- **Sky view**: the view mode that stands at the observer and looks up, showing
  satellites where they actually are in that person's sky. It owns the camera
  outright, which is why nothing is tracked while it is up.
- **Aim**: which way the sky view is pointing — azimuth, pitch above the
  horizontal, and roll about the view axis. Pitch, not elevation: the two are
  equal whenever the camera is looking at something, but a camera has an
  attitude where a satellite has a position.
- **Lock**: the satellite the crosshair currently holds — the nearest one above
  the horizon within the crosshair's reach. What a tap acts on, and what the
  detail card and the on-sky track describe.
- **Live vs pinned time**: whether the viewer's clock follows the present or a
  moment the user chose. Live is the default. The clock becomes pinned only by
  a deliberate act — a time supplied in the URL, or scrubbing the timeline —
  and stays pinned for the session, still advancing from that moment.
- **Sampled trajectory**: the sliding sample window of a satellite's position
  (half an orbit back, 1.5 forward) in both the fixed and inertial frames,
  kept fresh as time advances (`SampledTrajectory`).
- **Group store**: the persistence seam of the GP refresh pipeline —
  readIndex/writeGroup/writeIndex — with a Workers KV adapter (cron/API) and
  a disk adapter (static `data/gp/` snapshot) (`worker/src/gp/store.ts`).
- **GP source**: where the frontend gets GP data — the worker API when the
  probe succeeds, the static `data/gp/` snapshot otherwise, with a
  per-request API→static fallback mid-session (`src/modules/util/gpSource.ts`).
- **Preset**: the per-route starting configuration — a title, the element sets
  to register, and the default value of each shared setting. A preset supplies
  defaults, not initial state: the URL carries only deviations from the
  preset's values, so the same query string means different things on different
  routes (`src/config/presets.ts`).

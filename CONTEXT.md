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
- **Satellite metadata**: the bag of static facts a GP record carries beside its
  element set, interpreted by the frontend (`src/config/satelliteMetadata.ts`).
  Most are attached by the worker at refresh time from the satellite table and
  are opaque to it; the orbit class is instead derived by the frontend as it
  parses, because it follows from the element set every satellite already has.
  Provenance is per field, not per bag: a satellite absent from the table still
  carries its orbit class, and falls back to app defaults for the rest.
- **Swath extent**: the cross-track distance from the ground track to the edge of
  a sensor's footprint, held per side (starboard = velocity bearing + 90°). Not
  half a width: the sides differ when a sensor is tilted, so a swath is a pair of
  extents, and their sum is the total width.
- **Orbit class**: the orbit's regime — LEO, MEO, GEO or HEO — derived from the
  element set, never configured, so every satellite has one and it cannot
  contradict its own orbit (`orbitClassOf`). One class, three readers: it decides
  the colour of the satellite's point, the badge on its row in the browser, and
  whether it is drawn a ground track and a sensor cone at all.
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
  against. They are ordered, and the order is load-bearing in one place: the
  first is the observer. That is a fact about the list rather than about any
  station, which is why the ground station panel is a list in order, editable in
  place, with the first one marked.
- **Tracked satellite**: the satellite the camera follows. At most one, and the
  only value the globe reports back rather than merely receiving. Mutually
  exclusive with the sky view, which owns the camera itself: while the sky view
  is the active view mode nothing is tracked, and any attempt to track is
  undone.
- **Observer**: the point on the ground the sky view looks up from — the first
  ground station. Not a separate location: whoever the observer is, passes are
  already computed against them. It must be resolved before the sky view can
  open; where there is no ground station yet, the device's own location becomes
  one, and the sky view does not open if that is refused. Movable while the view
  is up — the movement keys walk it, and the ground station follows once they
  stop (`SkyMovement`).
- **Eye height**: how far the sky view's camera is above the ground under the
  observer. Standing height by default and raised by the movement keys, up to a
  ceiling that keeps "looking up from a point on the ground" a fair description.
  The view's, not the observer's: it is absent from the ground station and from
  the url, because a pass is computed against a point on the ground however high
  the eye is held above it.
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
  outright, which is why nothing is tracked while it is up. What it stands on is
  whatever surface is there — terrain, or the top of a surface model, which means
  a roof where a building stands at the observer.
- **Aim**: which way the sky view is pointing — azimuth, pitch above the
  horizontal, and roll about the view axis. Pitch, not elevation: the two are
  equal whenever the camera is looking at something, but a camera has an
  attitude where a satellite has a position. Roll is only ever driven by the
  device's own orientation; nothing the user does with a pointer rolls the view,
  and taking the aim back by hand levels it rather than leaving a roll no pointer
  can straighten.
- **Field of view**: how much sky the view shows, held as the vertical angle
  because that is the one a phone's two orientations agree on. Zoom is a change
  to it and to nothing else: the aim does not move when the view zooms.
- **Heading reference**: where the device's idea of north comes from when the
  sky view aims by compass. Without one an orientation sensor gives a yaw from an
  arbitrary zero, so the sky view declines to aim by compass rather than aim at a
  bearing nobody measured (`docs/adr/0004-compass-aiming.md`). Compass aiming ends
  when the control says so or when a drag takes the aim back — the sensor rewrites
  the aim every reading, so the two cannot share it.
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
- **Surface model**: the 3D representation of the ground and what stands on it,
  drawn over the globe. At most one, and none by default. Deliberately not
  symmetric: OSM Buildings adds extruded footprints to the globe's own surface,
  while Google Photorealistic 3D Tiles _is_ the surface — ground, vegetation and
  buildings in one mesh — which is why choosing it hides the globe and leaves the
  imagery and terrain selections describing nothing
  (`docs/adr/0005-surface-models.md`).
- **Inert**: said of a control whose selection is no longer describing what is on
  screen, because a surface model has taken over what it describes. Not the same
  as suppressed: suppression is about the store keeping a value that is not in
  force, inert is about the menu admitting it. A control can be inert and still be
  the user's to change — a hidden globe leaves the imagery choice theirs — or
  inert and not, where a terrain has been imposed.
- **Ground height source**: where the sky view's eye height comes from when the
  globe cannot say. The globe answers from loaded tiles every frame for free; a
  surface model has to be asked, once per observer, and answers with the top of
  whatever stands there (`SkyView.setGroundHeightSource`).
- **Basemap and overlay**: the two kinds of imagery layer. A basemap is the map of
  the world itself, so at most one is drawn; an overlay is data laid on top of it,
  and any number can be. Which kind a layer is, is a fact about the layer rather
  than about the selection (`base` on its registry entry), and it decides both the
  invariant and the control the menu offers.
- **Offline imagery**: the basemap that ships inside the app and is precached, so
  it is the only one guaranteed with no network. The high-resolution copy of the
  same map is data shipped beside the app and cached only as it is viewed: same
  map, different promise, which is why they are two selectable layers and not one.
- **Preset**: the per-route starting configuration — a title, the element sets
  to register, and the default value of each shared setting. A preset supplies
  defaults, not initial state: the URL carries only deviations from the
  preset's values, so the same query string means different things on different
  routes (`src/config/presets.ts`).

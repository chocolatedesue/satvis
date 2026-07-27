---
status: accepted
---

# Static satellite metadata and per-side swath extents

Per-satellite facts used to reach the browser as a rule list. `appMetadataConfig`
held seven rules keyed by exact name or `namePattern`; the worker served more at
`/api/metadata.json`; `SatelliteCatalog` fetched them, compiled their regexes,
merged every match over a defaults object, and memoized the result per entry
against a revision counter that `mergeMetadataConfig` bumped — because rules could
arrive _after_ the entries they applied to.

Two things were wrong with that. The pattern matching made claims nobody had
checked: `namePattern: "FENGYUN"` asserted a 2900 km swath for Fengyun 2G and 4A,
geostationary satellites with no cross-track swath at all, saved from being drawn
only by the `isLeo` gate. And `swathKm` was a single number, which cannot express
a tilted sensor: Sentinel-3's SLSTR reaches 1000 km to starboard and 500 km to
port, and the app carried 740 km — the nominal OLCI figure, wrong for the
instrument actually being drawn.

## Decision

**Facts are attached to the record at refresh time**, from a NORAD-keyed satellite
table in `satvis.core.yaml` (and plugin configs), merged into the generated config
and applied by `enrichRecords` inside `refreshGroups`. Both the worker API and the
static `data/gp/` snapshot go through that one path.

**Matching is by NORAD id only.** No patterns. A satellite gets a swath because
someone wrote its catalog number down, so the table is also a 1:1 mirror of the
upstream prediction table it was transcribed from, and re-syncing is a diff rather
than a translation.

**Swath is a pair of per-side extents**, mirroring that upstream shape, measured
cross-track from the ground track relative to flight direction.

The config format is YAML because the extents are only trustworthy with their
provenance — which value is a published instrument spec and which was calibrated
against real product footprints — and JSON cannot carry a comment.

### Consequences accepted

- **Six satellites lost their swath**: Fengyun 3A/3B/3C/3G/3H and METOP-SGA1 were
  covered only by `namePattern` and are absent from the upstream table. They fall
  back to the 200 km default. Preferred over inventing values: an absent entry
  reads as "we do not know", where a pattern-derived number reads as data.
- **Sentinel-3's ground track roughly doubles**, 740 → 1500 km, and other extents
  shift ~1% (Terra 2330 → 2350, Sentinel-2 290 → 300, VIIRS 3000 → 3130) as
  calibrated values replace nominal ones.
- **Up to 3 h of defaults after a deploy**, until the cron refresh (`23 */3 * * *`)
  rewrites KV, or a `POST /api/refresh` does it sooner.
- **`/api/metadata.json` is gone**, along with the browser-side rule matcher, the
  revision counter, and the per-entry memo it invalidated.

## The rendered swath and the predicted swath disagree

Pass containment uses the sides separately. The ground track does not: it stays a
Cesium corridor of one width, `starboard + port`, drawn symmetrically about the
track.

So for Sentinel-3A/B the drawn corridor extends 750 km per side while passes are
computed at +1000/−500. A ground station shown inside the corridor on the port
side produces no pass.

This is deliberate. Drawing it correctly means replacing the corridor with a
polygon whose vertices are offset per side — a change to `Orbit`,
`satelliteGraphics` and `SatelliteComponentCollection` that is separable from
getting the data right. Only two satellites are affected, their asymmetry is
modest (the corridor is within 250 km of truth on each side), and the pass list —
the thing people act on — is the half that is correct. The corridor is
orientation.

Revisit when a third asymmetric satellite appears, or when someone reports a pass
that "should" have happened.

## Why containment bounds two axes, not one

The obvious implementation of a per-side test is signed cross-track distance
against the side's extent. On its own it is wrong, and wrong in a way that looks
right: great-circle cross-track distance measures offset from the _track_, not
from the satellite. A station 1200 km straight ahead has a cross-track offset of
zero, so it would count as in-swath for as long as the satellite stayed on that
great circle — the pass would never end.

Containment therefore bounds both axes as an ellipse: cross-track by the extent of
the side the station falls on, along-track by the wider extent. For a symmetric
swath both axes share one radius and this is exactly the circle used before, so
the 37 symmetric satellites keep their pass windows unchanged and only genuinely
asymmetric footprints move.

The flight bearing comes from two subpoints 10 s apart rather than from the
velocity vector: `positionGeodetic` returns only the speed magnitude, and rotating
the ECI velocity into ECF without the ω × r term skews the bearing by a few
degrees — enough to matter for the side test near the along-track direction.

## Orbit class is derived, not stored

`operator` and `missionType` are genuinely static: CelesTrak's GP records carry no
such fields. `orbitClass` is not — it follows from `MEAN_MOTION` and
`ECCENTRICITY`, which every record has. Storing it would cover 39 satellites
instead of 10,000 and would eventually contradict the orbit printed beside it, so
it is computed in `Orbit.orbitClass`.

## Alternatives rejected

- **A `families` layer keyed by `namePattern`**, carrying nominal instrument
  swaths beneath the calibrated per-satellite ones. It would have kept the six
  satellites above and given new fleet members a sane value on launch day, but it
  reintroduces pattern matching and makes the table no longer a mirror of its
  upstream.
- **Group-scoped metadata**, i.e. `satellites[].metadata` applying only within its
  group. Rejected because a satellite's swath is not a fact about a group: FOREST-4
  appears in two OT groups and would have needed the value twice, kept in sync by
  hand. Row metadata instead lifts into the global table under the row's id.
- **Keeping a single `swathKm` total.** Simplest, and 37 of 39 satellites are
  symmetric — but it makes the Sentinel-3 asymmetry unrepresentable, and that
  asymmetry is verified against real SLSTR granule footprints.
- **Enriching every record with a default bag** so `metadata` is always present.
  Rejected: ~10,000 records would each carry a copy of `{swathKm: 200,
coneFovDeg: 10}` to say nothing. Defaults live in the frontend, and an absent
  key means "not in the table".

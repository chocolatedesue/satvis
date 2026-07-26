---
status: accepted
---

# URL parameter specification

The query string is a public contract: links are shared, bookmarked, and embedded in
third-party iframes (`embedded.html`) whose URLs we cannot audit. It had never been
written down, so its conventions had drifted into fourteen hand-written
serialize/deserialize closures with two different space escapes, two boolean
implementations (one wrong), and a declared `default` field that nothing read. This
ADR is the specification, and it freezes the wire format so existing links keep
working.

**This describes the target contract, not the current code.** The implementation is
`src/modules/util/pinia-plugin-url-sync.ts` plus the `urlsync` blocks in
`src/stores/*.ts`; it does not yet conform. Known deviations at the time of writing:
`fps` has no deserializer, nothing validates on serialize, invalid enum values are stored
and diverge from the scene, the whole-query rebuild does not exist (foreign parameters
survive only because `stateToUrl` reads them back out of `location.search`), `time` is
input-only and never emitted, and no `popstate` path re-applies state.

## Parameters

Every parameter is optional. An absent parameter means "use the default" (see
[Defaults](#defaults)).

| Parameter  | State                       | Kind                     | Wire form / accepted values                                                                    | Global default |
| ---------- | --------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- | -------------- |
| `elements` | `sat.enabledComponents`     | string list, space → `-` | comma-joined component names: `Point`, `Label`, `Orbit`, `Orbit track`, `Ground track`, `Sensor cone`, `3D model` | `Point,Label`  |
| `tags`     | `sat.enabledTags`           | string list, space → `-` | comma-joined tag names                                                                          | empty          |
| `sats`     | `sat.enabledSatellites`     | string list, space → `~` | comma-joined satellite names                                                                    | empty          |
| `xsats`    | `sat.disabledSatellites`    | string list, space → `~` | comma-joined satellite names opted out of tag activation                                        | empty          |
| `gs`       | `sat.groundStations`        | ground-station list      | `_`-joined; each station `lat,lon` or `lat,lon,name`; lat/lon emitted at 4 decimal places        | empty          |
| `track`    | `sat.trackedSatellite`      | string                   | one satellite name; empty means nothing tracked                                                 | empty          |
| `overpass` | `sat.overpassMode`          | enum                     | `elevation` \| `swath`                                                                          | `elevation`    |
| `layers`   | `cesium.layers`             | layer list               | comma-joined; each item `Name` or `Name_<alpha>`; list order is z-order                          | `OfflineHighres` |
| `terrain`  | `cesium.terrainProvider`    | enum                     | `None` \| `Maptiler`                                                                            | `None`         |
| `scene`    | `cesium.sceneMode`          | enum                     | `3D` \| `2D` \| `Columbus`                                                                      | `3D`           |
| `camera`   | `cesium.cameraMode`         | enum                     | `Fixed` \| `Inertial`                                                                           | `Fixed`        |
| `quality`  | `cesium.qualityPreset`      | enum                     | `low` \| `high`                                                                                 | `high`         |
| `fps`      | `cesium.showFps`            | boolean                  | `true` \| `false`                                                                               | `false`        |
| `bg`       | `cesium.background`         | boolean                  | `true` \| `false`                                                                               | `true`         |
| `time`     | clock time                  | timestamp                | emitted as ISO-8601 at minute precision (`2026-07-26T20:46Z`); any `dayjs`-parseable value accepted | absent (live)  |

`layers` items are validated against the leading segment before `_`. Base layers:
`Offline`, `OfflineHighres`, `ArcGis`, `OSM`, `Topo`, `BlackMarble`. Overlays: `Tiles`,
`GOES-IR`, `Nextrad`. The optional `_<alpha>` suffix sets that layer's opacity and has no
UI control. The accepted set is derived from the imagery-provider registry, not restated
— the current hardcoded copy in `src/stores/cesium.ts` is a duplicate that will drift.

At most one base layer may be active. When a URL supplies several, the **last in list
order wins** and earlier base layers are dropped; all overlays are preserved regardless.
Last-wins matches what toggling a base layer means to a user. Today `?layers=ArcGis,OSM`
instead leaves two base layers in the store and returns before assigning
`cc.imageryLayers` at all, so the scene never updates.

Note `ArcGis` (imagery) and `ArcGIS` (terrain) differ only in capitalisation and are
different things. The terrain provider is registered `visible: false`, so `?terrain=ArcGIS`
is not accepted. Do not "correct" either spelling.

`catalogRevision` and `pickMode` are store state that is deliberately **not** synced —
the former is a cache-invalidation counter, the latter a transient UI mode.

## Semantics

### Defaults

A preset supplies defaults, not initial state. The baseline for each parameter is the
preset-merged store value for the current route, so the same query string means
different things on different routes — on `/ot` the OT tag is the default and so is
absent from the URL. A parameter is emitted only when its value differs from that
baseline. Deviating from a preset therefore always produces a parameter, so no value is
unpersistable.

Defaults are computed at runtime from preset-merged state. The schema does not declare
them.

### Reading

An absent parameter resets its state to the default. Nothing invalid is ever stored, so
the store, the URL and the rendered scene cannot disagree. What "invalid" costs depends on
how it fails:

- **Malformed parameter** — the whole parameter is rejected, the state keeps its default,
  and the parameter is dropped from the URL. If the shape is wrong, none of it is
  trustworthy.
- **Unknown member of a closed vocabulary** (`elements`, `layers`, and the enums) — the
  offending element is dropped and the rest of the list is kept. A link written against a
  different build referencing a component that no longer exists should not wipe the whole
  selection. For a scalar enum there is no "rest", so this collapses to the malformed case.
- **Malformed element of `gs`** — that station is dropped, the remaining stations are
  kept.
- **Open vocabularies** (`tags`, `sats`, `xsats`, `track`) — **not membership-validated at
  all**, only format-validated. Group data loads lazily, so at parse time the catalog
  usually cannot say whether a name exists. Unknown names are retained and resolve if and
  when their group loads; this is already how `pendingTrackedSatellite` and
  `#ensureCatalogCoverage` are designed to behave.

### Writing

The whole query string is rebuilt from state on every change. Parameters not listed
above are preserved verbatim — this is not the codec's namespace.

A write that produces an identical query string is skipped entirely.

History entries represent user intent. User-initiated changes use `pushState`, so the
back button undoes them. Clock-driven changes to `time` use `replaceState`, because a
minute elapsing is not an intent; those writes are additionally throttled so a high
`clock.multiplier` cannot flood the history API. All history writes go through
vue-router so that `currentRoute` never goes stale, and back/forward re-apply state from
the query.

### Time

The clock is **live** by default and `time` is absent. It becomes **pinned** only by a
deliberate act: a `time` parameter in the incoming URL, or the user scrubbing the
timeline (Cesium's `Timeline` `settime` event). While pinned, `time` follows the clock at
minute granularity so a shared link reproduces the moment the sharer was looking at. A
link without `time` opens at the recipient's present, which is the behaviour that
predates this ADR.

## Naming constraints

The delimiters are in-band and cannot be escaped: `URLSearchParams` percent-decodes a
value before we split it, so `%2C` and a literal `,` are indistinguishable, and `~` is an
unreserved character for which `%7E` and `~` decode identically. Escaping is therefore
impossible without hand-rolling the query parse.

Instead, the affected vocabularies are constrained, and **the codec validates on
serialize as well as on parse** — an unrepresentable value is refused at the boundary
rather than silently corrupted.

| Vocabulary            | Constraint                     |
| --------------------- | ------------------------------ |
| tag names             | no `-`                         |
| component names       | no `-`                         |
| satellite names       | no `,`, no `~`                 |
| ground-station names  | no `,`, no `_`                 |
| imagery layer names   | no `_`, no `,`                 |

No existing name violates these. Component and layer names are closed, compile-time
vocabularies, so those two rows hold by construction. The satellite-name row is inherited
from `sats`/`xsats`; `track` is a bare string with no delimiter and could carry a comma on
its own, but the same name must be representable everywhere it appears.

Ground-station coordinates are stored at 4 decimal places (~11 m). This is a deliberate
size/precision trade, not a defect.

The `elements` constraint could be lifted later by resolving candidates against the seven
known component names, since that vocabulary is closed and fixed at compile time. `tags`
cannot: the catalog may not know every tag at the time the URL is parsed.

## Considered options

**Normalising the format** — one space escape, one separator — was rejected because
`elements=Point,Label,Sensor-cone` is a live, common URL. Dropping `-` → space on read is
what would be required to allow a literal hyphen, and that breaks every existing
multi-word `elements` and `tags` link.

**A raw-first reader** that splits the un-decoded query before percent-decoding each
element would make `,` escapable inside satellite and station names. Rejected: it means
hand-rolling `+` → space and percent-decoding, it still cannot rescue the `~`/`-`
escapes, and every trap it closes is latent rather than reachable — there is no
ground-station name input in the UI today, no tag or component name contains a hyphen,
and CelesTrak `OBJECT_NAME` values contain no commas. Validating on serialize gets the
safety without the parser.

## Consequences

`?fps=false` changes meaning. Today it deserializes to the truthy string `"false"` and
switches the counter **on**; with a boolean kind the link will do what it says. This is
the one intentional break in an otherwise frozen format.

`?terrain=Garbage` and its siblings stop diverging. Today the store accepts the value,
Cesium logs `Unknown terrain provider` and no-ops, and the store, URL and radio buttons
all report a terrain that was never applied. Validation will reject it on the way in.

Ground stations stop being stored as `NaN`. The store currently preserves `NaN`
coordinates for downstream callers to filter, and that filter
(`CesiumController.setGroundStations`) tests `gs.lat && gs.lon`, which also discards `0` —
silently dropping any station on the equator or the Greenwich meridian. Rejecting
malformed stations at parse time makes that filter unnecessary rather than merely
correct.

Adding a component or tag whose name contains a hyphen is a breaking change to this
contract, not a feature addition.

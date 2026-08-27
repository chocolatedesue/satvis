---
status: accepted
---

# The orbit lab: a generated constellation, and κ beside ν

Two things a satellite tracker cannot answer, and one panel that answers both.

The first is about geometry that does not exist yet. Everything in this app starts from
a CelesTrak element set, so the only constellations it can draw are the ones already in
orbit. A **Walker Delta** pattern — `i: T/P/F` — is how a constellation is specified
before it is launched, and the question "what does 72 planes of 22 at 53° actually look
like from here" has no answer in a catalog.

The second is about power. Eclipse is the question every satellite tracker answers, and
it is the wrong question: a satellite in full sunlight with its solar panel pointing away
from the sun has exactly as much power as one in the Earth's shadow. Reporting it as "lit"
is true about the light and false about the satellite.

## Decision

### A generated pattern is element sets, not a second kind of satellite

`walkerDeltaRecords` returns `GpRecord[]`, which is what `parseGpPayload` returns for
CelesTrak data. So a generated satellite is a catalog entry like any other: it gets an
orbit class, a ground track, a sensor cone, pass prediction against a ground station, a
row in the browser, a place in the propagation pool. None of that had to be taught about
Walker patterns, and none of it can drift from how a real satellite behaves.

**OMM rather than TLE.** A TLE is fixed-column with a checksum and a two-digit year, and
every one of those is a way to generate a constellation that parses as something slightly
else. The OMM arm of `GpRecord` takes the same numbers as named fields and reaches the
same `json2satrec`.

**One url parameter, in Walker's own notation.** `?walker=53:1584/72/17@550` rather than
five numeric parameters, because five can arrive inconsistent with each other: a T that
does not fill P planes is not a constellation, and the url should not be able to say it.
The string is also what a paper would print, so it needs no legend.

**A fixed epoch.** `WALKER_EPOCH_ISO`, not "now". A Walker pattern is a shape; an epoch
that moved with the clock would make every reload a slightly different one, because the
planes would have precessed by a different amount before the first frame.

**Satnums banded by a hash of the pattern.** Satnum is not a label here — the propagation
pool keeps one satrec per satnum for the life of the session (`laneIndexFor`), so two
patterns sharing satnums would put the second one's satellites on the first one's orbits.
Bands of `MAX_WALKER_SATELLITES` from 900000 keep them apart without a registry, and stay
clear of the NORAD catalog below.

**Generated on the store's say-so, activated separately.** The `walker` parameter is
expanded by `sceneSync` — the one place store state becomes globe state — and the records
are added to the catalog. Whether they are _drawn_ is a tag, the same switch every other
group has. Pressing Generate writes both, because a constellation nobody asked to see is
not what pressing Generate means.

**A tag per pattern, not one `Walker` tag.** The tag is the only switch a satellite has, so
with one shared tag generating a second pattern left the first still activated and still on
screen — nothing had turned its tag off. `Walker 53:1584/72/17@550` makes replacing a
pattern a tag swap, makes the browser's group list read as the patterns generated this
session, and leaves keeping two on screen one click away.

### Illumination is two channels resolved into five states

- **ν** — the fraction of the solar disc left uncovered by the Earth. `satellite.js`'s
  `shadowFraction` inverted, so umbra and penumbra are distinct rather than a cylinder's
  boolean.
- **κ** — the signed cosine between the sun and the solar panel's normal. Not clamped:
  the sign is the entire point.

Five states rather than two, because a reader wants to know _why_ there is no power:
`umbra`, `penumbra`, `sunlit_back`, `sunlit_edge`, `sunlit_on`. `sunlit_back` is the state
the vocabulary exists for.

**κ is a model, and says so.** Nothing in a GP element set describes attitude, so κ cannot
be derived — only assumed. The assumption is therefore _selectable_ (`PanelAxis`: zenith,
velocity, orbit normal) and named in the readout, so a reader can see how much of the
answer it decides. The default is zenith — a body-fixed panel on the anti-Earth face of a
nadir-pointing bus — because it is the only one of the three whose κ changes sign within
one orbit, which is what makes `sunlit_back` a state the timeline visits rather than a
seasonal fact.

**ν and κ come from the satrec, not from the drawn position.** The sampled trajectory is
pseudo-fixed and interpolated; κ is a cosine against a frame built from position _and_
velocity. Reading the satrec directly is what keeps the two consistent by construction.

### Two ways of showing the same five states, because they answer different questions

The point colour answers "what is happening to this satellite **now**". It needs the
clock to be read: to see that an orbit has an eclipsed arc at all, you have to watch a
satellite fly into it.

The **illumination arc** answers "what happens **along this orbit**". It is the orbit line
itself, drawn with one colour per vertex, so the eclipsed arc, the penumbra slivers either
side of it and the arc where the panel has turned away are all in view at once, in place,
on a paused clock. That is the reading a constellation designer wants and the point colour
cannot give.

Both, not one:

- A separate **component**, not a second mode of the Orbit component. The plain orbit is
  context — one of ten thousand translucent ellipses nobody reads individually — and the
  arc is the thing being read, at full opacity and a wider line. Someone comparing two
  constellations wants the first without paying for the second.
- **Per-vertex colours on one polyline**, not one polyline per state run. A run boundary is
  a vertex either way, and a single `GeometryInstance` keeps the component the same shape
  as every other one, so the existing enable/disable and `replace` paths need no changes.
  It also renders a boundary as a one-segment gradient rather than a hard edge, which is
  what a penumbra looks like.
- **Its own batch.** Cesium builds one vertex-attribute layout per `Primitive`, and the arc
  carries colour in the geometry while a plain orbit carries it as a per-instance
  attribute. The two cannot share a primitive, so there is a third `PolylineBatch`.
- **Coloured from the ring, not from a second propagation.** `illuminationAlongOrbit` takes
  the vertices the polyline is already drawn from, holds the sun fixed across the orbit
  (0.07° over 96 minutes) and takes the velocity as a central difference along the ring.
  So the arc overlays the orbit exactly, in the orbit's own frame, with no frame conversion
  and no second SGP4 pass.
- **Re-cut on the tracks' schedule.** The inertial ellipse is kept current by a model
  matrix, but the sun moves through that frame — nothing at ×1 across one orbit, a whole
  eclipse season at ×86400 — so the arc is stale geometry in a way the orbit is not.

### The strip covers two orbits, and there is a two-orbit demo

The panel's per-satellite strip runs **two** orbital periods rather than one: one orbit
cannot show what changes _between_ orbits, and where a satellite is near the edge of
eclipse season two orbits is where that first reads as two visibly different halves.

And the smallest useful scene gets a **button**. "Two-orbit demo" writes the six things
that only make sense together — a 20/2/1 pattern (two planes 90° apart, ten satellites
each), its tag, the Point and Illumination arc components, the illumination colouring, the
large point size, and a 60× clock — because "show me the simplest version of this" should
not be six menus. None of it is a mode; every one of the six is still the user's to change
afterwards.

Three of those six are about being _watchable_ rather than about being correct, and each was
wrong in the first version:

- **Ten satellites per plane, not one.** One satellite is in one state, so the legend has one
  row occupied and the picture says nothing about the rest. Ten per plane leaves every state
  occupied at once, and is still few enough to follow a single one round.
- **Large points.** 5 px is the size that keeps ten thousand satellites from hiding the
  globe. It is also too small to read a colour off, which is the entire premise here. So the
  size became a setting (`POINT_SIZES`) rather than a compromise: small for a constellation,
  large for a scene someone is reading. The label offset is derived from it, because a label
  10 px out starts inside a 14 px point.
- **A 60× clock.** At 1× a 550 km orbit is 95.6 minutes, so a scene coloured by what the sun
  is doing shows nothing happening. The clock is live viewer state rather than store state,
  so the demo writes it through `useViewerClock` — the same seam the clock deck uses — rather
  than reaching into `viewer.clock`.

### A second colour mode, not a sixth orbit class

`ORBIT_CLASS_COLOR` answers a standing question about the orbit; illumination answers what
the sun is doing right now. Folding one into the other would force a satellite to be either
LEO or eclipsed. So `pointColorMode` is a mode, and only that mode pays for itself: the
point's colour is a constant in orbit-class mode and a `CallbackProperty` in illumination
mode, and switching between them tears the points down and rebuilds them
(`SatelliteManager.repaintPoints`) rather than leaving ten thousand points evaluating a
callback that returns a constant.

The per-frame read is bounded by `IlluminationCache`, which memoizes on a one-second grid
of simulation time. At the default 1× that is sixty reads collapsed into one. At 3600× it
buys nothing, because there every frame _is_ a new second — the honest cost of colouring
by a physical quantity rather than by a standing fact.

## Alternatives

**Generate TLE text and feed it through the existing text parser.** Rejected: it makes
column arithmetic and a checksum part of the geometry, and `parseGpPayload`'s browser arm
degrades by warning and skipping, so a generator bug would silently produce a smaller
constellation.

**Take κ from a real attitude profile.** There is no source for one. A yaw-steering law
would be a second model with more parameters and the same standing as this one, presented
with more authority.

**Colour by ν alone.** That is what every other tracker does, and it is the thing this ADR
exists to fix.

**A dedicated `/walker` route with its own preset.** Rejected for now: presets supply
per-route defaults (ADR 0001), and the pattern is already a url parameter that works on
every route. A route would add an entrypoint and an SPA-fallback path for no capability.

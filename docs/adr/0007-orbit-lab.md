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
are added to the catalog. Whether they are *drawn* is a tag, the same switch every other
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

Five states rather than two, because a reader wants to know *why* there is no power:
`umbra`, `penumbra`, `sunlit_back`, `sunlit_edge`, `sunlit_on`. `sunlit_back` is the state
the vocabulary exists for.

**κ is a model, and says so.** Nothing in a GP element set describes attitude, so κ cannot
be derived — only assumed. The assumption is therefore *selectable* (`PanelAxis`: zenith,
velocity, orbit normal) and named in the readout, so a reader can see how much of the
answer it decides. The default is zenith — a body-fixed panel on the anti-Earth face of a
nadir-pointing bus — because it is the only one of the three whose κ changes sign within
one orbit, which is what makes `sunlit_back` a state the timeline visits rather than a
seasonal fact.

**ν and κ come from the satrec, not from the drawn position.** The sampled trajectory is
pseudo-fixed and interpolated; κ is a cosine against a frame built from position *and*
velocity. Reading the satrec directly is what keeps the two consistent by construction.

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
buys nothing, because there every frame *is* a new second — the honest cost of colouring
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

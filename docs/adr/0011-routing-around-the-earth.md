---
status: accepted
---

# Routing around the Earth: a chord through the planet is not a long link

The migration overlay used to hand a KV cache to the nearest powered satellite whether or not
the two could see each other. That was a deliberate change — refusing an occluded target left a
stage dark for half an orbit while powered satellites sat idle over the limb, which is the state
the illumination vocabulary exists to call wrong — and it was later made honest rather than
fixed: the hop was flagged `inView: false`, drawn faint and labelled "no direct view".

Honest is not the same as physical. **A chord that passes through the Earth is not a long link.
It is not a link.** No power budget, antenna or protocol makes one, so a transfer credited over
it is a transfer the model invented, and the pipeline's headline numbers rested on those: in the
two-orbit demo _most_ hand-offs were through the planet.

## Decision

**Line of sight is a requirement, and a relay is how it is met.** `routesFrom` runs Dijkstra over
the fleet's visibility graph, weighted by wire length, and returns the shortest path from a host
to every satellite it can reach. `chooseRouteExcluding` keeps the four-tier preference the target
selection always had — lookahead-safe and direct, direct, lookahead-safe by relay, by relay — and
the tier that used to mean "occluded, taken anyway" now means "reached around the limb".

**The path length is whatever the geometry needs, and one relay is not enough.** A satellite at
550 km sees to a horizon 21.2° of Earth-central angle away, so a pair can link across at most
**42.5°** — about a ninth of the way round the planet. One relay doubles that and no more;
reaching a satellite 170° away takes five legs. A fixed hop budget would not be a simplification,
it would be a different and wrong answer, so there is no budget.

**Every intermediate node must be powered; the source is exempt.** A relay has to receive and
retransmit, and a satellite whose panel has turned away can do neither. The host handing its
cache off _because_ it is going dark is the premise of the whole overlay, and is the one
transmission the model already assumed. A relay may be another stage's host: forwarding a packet
is not hosting a stage, and refusing that would throw away the densest part of the fleet.

**`stranded` now means stranded.** When the Earth sits between a dark host and every lit
satellite, and no chain of lit satellites reaches around it, there is no link — and that is the
state, rather than a hop drawn faint with a caveat attached.

**The check moved from the hop to the leg.** `verify-migration.mjs` bounds each leg by the link
horizon rather than the hand-off by it: a 9000 km hand-off is fine as two 4500 km legs
and impossible as one chord, and only the legs tell those apart. Before this change the
demo logged single chords of 8149–11 215 km; after it, every leg is ~4283 km and the long
hand-offs are two of them.

**The closed form goes in the layout math too.** `maxLinkRangeKm` and `linkHorizonAngleDeg`
(`shellLayout.ts`) give `√(r₁²−R_b²) + √(r₂²−R_b²)` and `arccos(R_b/r₁) + arccos(R_b/r₂)`, so a
shell pair or a cluster reports the longest link it could ever close alongside whether its
geometry returns. A layout that repeats forever and never comes within its own link horizon is a
layout with no fabric on it, and nothing before this said so.

## Consequences

- **The pipeline's numbers change, downward, and they are now earned.** A relayed hand-off
  travels further and takes longer than the chord it replaced; some hand-offs that used to happen
  now strand instead. That is the model getting more expensive by getting more honest.
- **Cost is O(N²) line-of-sight tests plus O(N²) search per evaluation**, over the active fleet
  and on the migration cadence rather than per frame. One Dijkstra serves every candidate, which
  is why the search is per host rather than per host-candidate pair.
- **Serialisation is still charged once, not per leg.** The transfer cost is one serialisation
  plus propagation over the whole wire — a cut-through relay. Store-and-forward would charge
  160 ms per leg at 100 Gbps, which is a real modelling choice and a separate one; it is in
  `TODO.md` rather than assumed here.
- **The overlay draws the path.** The migration polyline runs through every hop, bending at each
  relay, and the packet walks it by length so it does not sprint the short leg. The halo reads
  `S1 · P01-08 → P02-03 → P01-02`.
- **A "550 km" orbit is not at 6921 km, so the runtime bound is not the label's.** Two effects
  lift it: SGP4 works in WGS-72, so the altitude label means a 6928.1 km semi-major axis rather
  than the 6921.0 km `6371 + 550` implies, and J2 makes a _nominally circular_ orbit breathe
  ±6.0 km about that. The demo's Walker ranges over **6921.0–6933.0 km**, so its real leg limit
  is **5079.6 km** against the 5013.9 km the label gives, and `verify-migration.mjs` derives its
  bound from the radius reached — a check written to `6371 + 550` would have failed a legal link.
  `maxLinkRangeKm` needs no such correction: its WGS-72 nominal sits 0.14 km from the measured
  mean radius, and the oscillation swings its 5016.6 km answer over 4977.1–5043.2 km either side
  of it, which is the right way for a design figure to behave.
- **Two Earth radii are in play**: `migration.ts` tests the segment against the mean radius
  (6371 km), `shellLayout.ts` computes the horizon against the WGS-72 equatorial one
  (6378.135 km) it does its orbital mechanics in. 2.7 km apart on a ~5015 km horizon, well inside
  the 80 km atmospheric margin both apply. Neither is uniformly the conservative choice —
  the mean radius under-blocks an equatorial chord by 7.1 km and over-blocks a polar one by
  14.3 km — which is what the margin is for.
- **The ring rule keeps its published bar.** `minSatellitesPerRing` still clears the _solid_
  Earth by default — S ≥ 8 at 550 km, the number `0008` and `0009` quote — and now takes a margin,
  which at 550 km asks for S ≥ 9. Changing the default would silently restate those ADRs.

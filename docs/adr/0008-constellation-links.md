---
status: accepted
---

# Constellation links: the topology that is drawn, and the cluster that is marked

Once the orbit lab can generate a Walker constellation, the natural next question is not
"where are the satellites" but "how do they hold together". A constellation is a promise
about geometry — planes evenly spread, slots evenly filled, neighbours where you put them —
and none of that promise is visible in a scatter of points. This ADR decides which
inter-satellite links the app draws, and how a viewer can mark a small fleet of satellites
to watch as a unit.

## Decision

**The drawn topology is the one the derivation picks, not the one a viewer can tune.**
`scripts/derive-isl-topology.mjs` expands the same Walker patterns the orbit lab generates,
flies them with SGP4, and scores every candidate wiring on two quantities: link-length
discipline (how far a link stretches over an orbit, as a coefficient of variation) and
identity stability (how often each satellite's nearest neighbour in the neighbouring plane
changes). The rules that survived are encoded in `constellationLinks.ts`:

- **Intra-plane rings** — every satellite links its ring neighbours in the same plane.
  Equal periods keep the spacing exact; the measured length CV is ≈ 0.001. Rigid by
  construction, not by effort.
- **Same-slot links between adjacent planes** — plane _p_ slot _s_ links plane _p+1_ slot
  _s_. Both satellites advance at the same rate, so the along-track offset between the pair
  is constant forever: the link breathes with the plane geometry (CV 0.14–0.27) but its
  endpoints never re-wire. This is the Iridium inter-plane pattern.
- **No wrap link across a counter-rotating seam.** The wrap pair of planes (last to first)
  is linked only when their orbit normals agree (`sin²i·cos ΔΩ + cos²i > 0`). On a Walker
  Star the normals oppose, same-slot satellites sweep past each other at twice orbital
  rate, and the measured link length swings 1.5–14 thousand km (CV 0.74) with tripled
  identity churn. Iridium closes its seam for the same reason.
- **Nothing between patterns.** Different shells with different periods drift through each
  other monotonically; the nearest satellite across shells never settles (churn 0.20 per
  sample, no convergence). _Narrowed by `0009`: a pair sharing an altitude **and** an
  inclination has equal mean motion and equal node rate, so every offset between it is
  frozen — that pair is one shell in two patterns, and is bridged._

The graph is rebuilt from whatever subset of each pattern is currently active, and a link
whose chord passes behind the Earth is hidden rather than drawn through it — the same
standard the migration overlay sets.

**A marked cluster is the exception that proves the rules.** The auto-topology deliberately
says nothing about satellites in different shells; a viewer who wants to _check_ that
silence by eye needs an API that ignores it. `mark=` takes `<plane>-<slot>@<wire>` tokens
(1-based, matching the `P01-01` labels on screen): each active member gets an amber halo and
its slot label, and every marked pair is bonded pairwise in amber — across planes and across
shells, rules aside. A same-slot column across one shell's planes holds its geometry exactly;
a same-slot satellite from each of three shells shears open as the periods slip, and the
bonds show which is which from the first frame.

**The overlay is on by default** (`links=true`): a constellation without its topology is
just points, and hiding the links that hold costs a viewer the whole story. `links=false`
turns it off.

## Consequences

- The derivation is a script, not a paper: it reruns against any pattern in a couple of
  seconds, and the numbers quoted here are its output, rerunnable by anyone.
- The ring rule exposed a fleet-design constraint the demo now honours: a ring link's chord
  clears the Earth only when `a·cos(π/S) > R`, which at 550 km asks for **S ≥ 8 per plane**
  (at 1200 km, S ≥ 6). The stacked-shells demo flies its 550 km shell with 10 per plane so
  its ring links do not run through the ground.
- Marked bonds ignore the topology rules but not the Earth: a bond is a relation rather
  than a live link, so when its chord passes behind the planet it dims to quarter opacity
  rather than disappearing. A holding cluster never looks like it falls apart once per orbit,
  while the dimming still signals when line of sight is broken.
- The "nothing between patterns" rule was read as a fact about shells and is a fact about
  shells nobody designed to hold together. `docs/adr/0009-multi-shell-layouts.md` designs the
  ones that do — match the node rates, then close the along-track cycle — and narrows this
  ADR's cross-pattern rule to the rigid case.
- A marked pair **can** span orbits and still hold: equal altitude means equal period, and
  the derivation measured a same-period cross-inclination pair whose per-orbit distance
  maxima repeat unchanged (3620, 3617, 3621 … km) while a different-period pair wanders
  without bound (5622 → 14507 → 5077 km). Bonds are drawn accordingly — solid for
  same-period members, dashed for drifting ones — so the verdict is on the line, not in
  the panel.
- The `mark=` tokens name satellites by pattern coordinates rather than catalog names, so
  they survive the naming of individual element sets and carry no spaces or commas; a token
  whose satellite is not currently active contributes nothing and joins the moment its
  satellite is switched on.

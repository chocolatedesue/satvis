---
status: accepted
---

# Multi-shell layouts: the second shell that holds, and the one that only looks like it does

`0008` wired each shell to itself and stopped: _"Nothing between patterns. Different shells
with different periods drift through each other monotonically; the nearest satellite across
shells never settles."_ That was true of the shells it measured — a 53° / 550 km fleet and a
97.6° / 1200 km one, picked for their coverage — and it was read as a fact about shells in
general. It is not. It is a fact about **shells nobody designed to hold together**, and this
ADR is about the ones that are.

The question a space-compute fabric actually asks is not "are these two shells still" but
"can I compute a cross-shell schedule once, or must I recompute it forever". That question
has an answer, it is closed form, and it picks out a specific second shell.

## Decision

**Two rates decide everything, and both are closed form.** A circular shell is described by
its altitude and inclination, and what it does relative to any other shell follows from:

- **The node rate** `Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i` — how fast the J₂ bulge turns the orbit
  plane. Where two shells' node rates agree, their planes hold a fixed arrangement forever.
  Where they do not, the crossing seam walks round the globe at the difference: 5.21°/day
  between the 550 km and 1200 km shells the stacked-shells demo flies, which is a degree of
  seam every four and a half hours.
- **The along-track rate** `u̇ = ṁ + ω̇ = n[1 + J₂ (Rₑ/a)² (6cos²i − 3/2)]` — how fast a
  satellite runs round its own orbit from its node. Where the ratio of two shells' along-track
  rates is a small-integer ratio `p:q`, the phases return every `p` orbits of one and `q` of
  the other.

**No two distinct shells are rigid, and that is a theorem rather than a limitation.** Freezing
the phases wants equal mean motion, which wants equal altitude. Freezing the planes wants
equal `Ω̇`, which at equal altitude wants equal inclination. Both at once is the same shell.
So "stable across shells" cannot mean "still", and any design that promises it is quoting a
number over too short a window.

**What it can mean is _periodic_, and that is designed in two steps.** Pick the companion's
inclination so the node rates match — `cos i₂ = cos i₁ · (a₂/a₁)^(7/2)`, one line — and pick
its altitude so the along-track ratio closes a cycle. Both conditions on two unknowns, solved
by `src/modules/util/shellLayout.ts`: the inclination follows the altitude in closed form, so
only the altitude is searched, and along-track rate falls monotonically with it, which makes
the search a bisection. Against a 53° / 550 km reference the search returns, shortest cycle
first:

| cycle | companion           | repeat  |
| ----- | ------------------- | ------- |
| 6:5   | 1455.8 km at 22.30° | 9.56 h  |
| 7:6   | 1308.1 km at 30.05° | 11.15 h |
| 8:7   | 1201.9 km at 34.47° | 12.75 h |
| 9:8   | 1121.8 km at 37.41° | 14.34 h |

**The co-precession ceiling is a real design limit, not a solver failure.** `cos i₂` grows
with the 7/2 power of the altitude ratio and passes 1: above **1632 km** nothing can keep a
53° / 550 km shell's node company, because no inclination at that altitude precesses slowly
enough. Every companion above the reference lives under that ceiling, which is why the short
cycles (2:1, 3:2) are unavailable and 6:5 is the fastest return on offer.

**The price of the lock is inclination.** A companion node-locked to a 53° shell flies at
49.6° at 700 km, 44.3° at 900 km, 34.5° at 1200 km and 9.5° at 1600 km. The layout buys a
schedule and spends latitude coverage; a fleet that needs both needs a third shell, not a
different solution to this one.

**The claim is checked against a propagator, not against itself.**
`scripts/derive-isl-topology.ts` studies 7–10 fly the designed pair with SGP4 and measure it:

- **Node lock (study 8).** The designed 8:7 companion shears at **0.0048°/day** — a degree of
  seam every 209 days — against 5.21°/day for the 97.6° shell at the same altitude and
  2.63°/day for the demo's two same-period shells. The secular model lands 0.216° and 2.7 km
  from where the propagator wants it, and the script refines both against SGP4 (**1199.2 km at
  34.685°**), after which the measured shear is zero to five decimals.
- **Return (study 9).** One repeat cycle later, does each satellite of the low shell find the
  same cross-shell partner at the same range? The refined pair: **99.7%, median range change
  4 km**. The unrefined secular pair: 95.7%, 94 km. A shell at the same altitude and the
  reference's own inclination: 93.5%, 247 km. The stacked-shells demo's 97.6° shell: **79.3%,
  398 km**.

**The topology bridges across patterns only where the pair is rigid.** `0008`'s rule is
narrowed rather than reversed: two patterns that share an altitude _and_ an inclination have
equal mean motion and equal node rate, so every offset between them is frozen and there is
nothing an inter-plane link has that a link across the pair lacks. That pair is not two
shells — it is one shell flown as two patterns, which is what a second RAAN offset or a phased
sub-constellation is — and it is now wired as one, in **sky blue**: each plane to the plane of
the other pattern nearest it in right ascension, same slot, dropped when the two planes
counter-rotate. Everything else stays unwired, the designed companion included: its
_schedule_ repeats, its _partner_ does not, and a fixed line between two satellites that will
be 14 000 km apart in six hours is not a link.

**A marked bond carries the verdict.** The five outcomes a shell pair can earn are
`rigid` (equal period, equal node rate), `repeating` (node-locked and resonant),
`phase-locked` (equal period, planes shearing — the demo's two 1200 km shells),
`node-locked` (planes held, phases sliding — every co-precessing altitude that is not also
resonant) and `drifting` (neither). A bond is drawn **solid** when its geometry comes back
(the first three) and **dashed** when it does not, which keeps the old same-period rule
exactly where it was and adds the designed companion to the solid side.

## Consequences

- The orbit lab reports the layout facts for whatever is in its form — node rate,
  co-precession ceiling, the best companion and its cycle — and **Add the companion shell**
  puts that companion on the globe beside the reference. A pairwise verdict table names what
  every generated pattern does to every other, which is the question a multi-shell fleet does
  not have one answer to.
- `?demo=stable-shells` flies the comparison: the reference, its designed 8:7 companion and a
  97.6° / 1200 km control, with one satellite of each marked. The bond to the companion is
  solid and returns to its shape every ~76 s of wall clock; the bond to the control is dashed
  and never does.
- The demo generates its companion from `resonantCompanion` at runtime rather than from the
  script's refined numbers, so the app has one source of truth and the panel's arithmetic and
  the scene's geometry cannot disagree. The cost is the 0.0048°/day the refinement would have
  removed, which is a degree of seam over seven months — below what a secular model is
  entitled to claim anyway.
- `shellLayout.ts` carries **no runtime imports**, because the derivation script runs it
  through node's own type stripping. The one formula that costs — the Keplerian mean motion —
  is restated from `walkerDelta.ts` and asserted equal to the last bit in the tests, which is
  the difference between a duplicated formula and a divergent one.
- A repeat cycle is capped at 32 revolutions of the reference (~2 days at LEO). Past that
  every ratio is approximable by something and "resonant" stops distinguishing anything, which
  is the same as describing nothing.
- Nothing here is a mission analysis: secular J₂ on a spherical Earth, no drag, no third body,
  no station-keeping. What it is good for is what it is used for — choosing where a second
  shell goes, and knowing which of the five things it will then do.

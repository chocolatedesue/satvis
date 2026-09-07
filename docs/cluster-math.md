# Cluster maths

A crib sheet for the two things this repository calls a cluster, in formulas, thresholds and
measured numbers. It is a reference, not a decision — the decisions are
`docs/adr/0010-stable-clusters.md` (across orbits) and `docs/adr/0012-orbit-formations.md`
(inside one orbit), and this file exists because reading both to compare a threshold is tedious.

For _which orbit to put a compute cluster in_ — how geometry, energy and inference pipeline
depth constrain the choice together — see `docs/orbital-compute.md`. This file is the
geometry and drag; that one is the synthesis.

They are different scales with different maths, and the shared word is the only thing they have in
common:

|                   | **stable cluster**               | **formation cluster**           |
| ----------------- | -------------------------------- | ------------------------------- |
| what is clustered | orbits (shells)                  | satellites inside one orbit     |
| separation        | hundreds to thousands of km      | 10 m to ~100 km                 |
| the variable      | two secular rates                | one eccentricity vector         |
| the question      | does the configuration come back | does the configuration stay put |
| lives in          | `shellLayout.ts`                 | `clusterFormation.ts`           |

Everything below is secular J₂ two-body in WGS-72 (`Rₑ = 6378.135 km`, `μ = 398600.8 km³/s²`,
`J₂ = 0.001082616`), on a spherical Earth. No drag, no third body, no J₃, no station-keeping.
Good for choosing and recognising a layout; not for predicting one.

---

## Stable clusters

### The two rates

A circular orbit is `a` and `i` plus two angles that run. To secular order in J₂:

```
n  = √(μ / a³),        a = Rₑ + h
Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i
u̇ = ṁ + ω̇ = n [1 + J₂ (Rₑ/a)² (6 cos²i − 3/2)]
```

**The whole reduction:** the relative motion of two orbits is governed by exactly two differences,
`ΔΩ̇` (which shears their planes apart) and `Δu̇` (which slides their phases through each other).
The initial `Ω` and `u` offsets are constants of the motion. Everything else about the pair follows.

### The five verdicts

| verdict        | condition                       | what it means                                                     |
| -------------- | ------------------------------- | ----------------------------------------------------------------- |
| `rigid`        | same period ∧ same `Ω̇`          | every offset frozen — one shell flown as two patterns             |
| `repeating`    | `Ω̇` matches ∧ `u̇₁/u̇₂ ∈ ℚ` small | the whole configuration returns every cycle — the designed answer |
| `phase-locked` | same period, `Ω̇` differs        | along-track holds, planes shear underneath                        |
| `node-locked`  | `Ω̇` matches, no resonance       | half a layout: planes hold, phases slide forever                  |
| `drifting`     | neither                         | nothing repeats                                                   |

### Thresholds

| constant                          | value | why that value                                                                                                                                                                                             |
| --------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_LOCK_TOLERANCE_DEG_PER_DAY` | 0.01  | a degree of seam movement in 100 days; loose enough that the secular model's own error against SGP4 (a few 1/1000 °/day) does not disqualify a pair it designed, tight enough that 2.58 °/day never passes |
| `PERIOD_LOCK_TOLERANCE`           | 1e-5  | relative; a part in a hundred thousand                                                                                                                                                                     |
| `REPEAT_SLIP_TOLERANCE_DEG`       | 1     | ≈ 130 km along-track at LEO — a contact schedule absorbs that, ten degrees it does not                                                                                                                     |
| `MAX_REPEAT_REVOLUTIONS`          | 32    | beyond ~2 days every ratio is approximable by something, so "resonant" describes every pair — which is another way of describing none                                                                      |
| `MAX_CLUSTER_CYCLE_HOURS`         | 48    | at that point a schedule is a calendar                                                                                                                                                                     |
| `LINK_MARGIN_KM`                  | 80    | top of the mesosphere; a chord that grazes the limb passes through atmosphere no optical ISL survives                                                                                                      |

### Why it is a quotient, not a search

`Ω̇(x) = Ω̇(y)` is equality of a real number — reflexive, symmetric, transitive by inspection.
`u̇₁/u̇₂ ∈ ℚ` is an equivalence relation for the same reason multiplication by a rational is
invertible. The intersection of two equivalence relations is one, and its classes are **exactly the
maximal stable clusters**.

So a member does not need checking against its neighbours: it needs only to lie on one level set of
`Ω̇`, which is one curve in the (altitude, inclination) plane:

```
cos i = Ω̇* / K(a)
```

**N constraints, not N².** And there is consequently no `k` to choose, no distance to minimise, no
centroid to iterate. A k-means over orbital elements would impose an arbitrary partition on a space
that has a canonical one, and would answer a question about Euclidean proximity where proximity
means nothing: two shells 3 km apart in altitude drift through each other forever, two 700 km apart
can hold a schedule for years.

### What the theory does not survive: tolerance

No two flown orbits have exactly equal `Ω̇`, and every real ratio is rational to within any ε. Both
relations must be relaxed before they describe anything real — and **a relaxed equivalence relation
is not transitive**. A within ε of B and B within ε of C leaves A and C 2ε apart.

Clusters under tolerance therefore **overlap rather than partition**, and the honest output is the
set of _maximal_ clusters, not an assignment of each satellite to one. `nodeLockedGroups` returns
overlapping groups for this reason.

Both stages remain exact:

1. **Node lock is intervals on a line.** Sort by `Ω̇`; a cluster is a window whose spread is within
   tolerance; the maximal ones are the maximal cliques of an interval graph, which one pass over the
   sorted values enumerates. `O(N log N)`.
2. **The common cycle is simultaneous rational approximation with a budget.** Any cycle `T` is, to
   within the slip tolerance, a whole multiple of every member's period — so enumerating the
   multiples of one member's period up to the budget enumerates every candidate, and each candidate
   _names_ the subset that closes it. `O(N²·K)`, N being distinct orbits rather than satellites.

**Use the along-track period `360/u̇`, never the Keplerian one.** They differ by a part in a
thousand, which is 3° of phase after fifteen revolutions — the entire error budget a cycle has.
Anchoring on `periodMinutes` finds no cluster at all, including the family it was handed. That is
not hypothetical; it is what the first implementation did.

### Constructing a family, in closed form

```
co-precessing inclination:  cos i₂ = cos i₁ · (a₂/a₁)^(7/2)
co-precession ceiling:      a₁ · |cos i₁|^(−2/7) − Rₑ
ring link count:            smallest S with a·cos(π/S) > Rₑ + margin
link horizon (range):       √(r₁² − R_b²) + √(r₂² − R_b²),  R_b = Rₑ + 80 km
link horizon (angle):       arccos(R_b/r₁) + arccos(R_b/r₂)
```

`shellFamily` fixes the reference's revolutions per cycle — which fixes the cycle — and then every
other whole number of revolutions inside the altitude band names one more shell on the same node
rate curve. Every pair repeats by construction. Choosing a shared cycle rather than pairwise ratios
is the point: pairwise ratios would need a least common multiple that grows with every shell added,
and a shared cycle does not grow at all.

### Measured conclusions

| reference      | cycle  | shells | inclination span |
| -------------- | ------ | ------ | ---------------- |
| 53° / 550 km   | 23.9 h | 3      | 32.5°–53.0°      |
| 53° / 550 km   | 47.8 h | 7      | 22.3°–56.1°      |
| 53° / 550 km   | 71.7 h | 11     | 17.2°–57.1°      |
| 86.4° / 780 km | 48.6 h | 10     | **83.8°–87.1°**  |

- Co-precession ceiling: **1632 km at 53°**, **9407 km at 86.4°** — matching a node rate near zero
  costs almost no inclination. **A fleet that wants many stable shells should be near-polar.**
- Roughly one more shell per six hours of cycle at 550 km.
- **Sun-synchronous is the strongest case**: `Ω̇* = +0.9856°/day` makes every member sun-synchronous
  by construction, so the family holds a fixed local solar time _and_ returns its cross-shell
  geometry every cycle — a fixed illumination geometry and a repeating contact schedule at once.
- Study 12: a mixed fleet of twelve orbits returns the designed family whole (plus the sub-families
  that come back sooner) and two `rigid` pairs, with nothing chosen for coverage joining anything.

---

## Formation clusters

### From Clohessy-Wiltshire to elements

The usual description puts the origin on a reference satellite, `x` radial and `y` along-track.
Bounded motion is `ẏ₀ = −2n x₀`, and what it produces is a 2:1 epicycle:

```
x(t) = A sin(nt + φ)
y(t) = 2A cos(nt + φ) + y_c
```

That needs an integrator. But **a 2:1 epicycle about a circular reference is a small eccentricity
and nothing else**, to first order in `e`:

```
r = a(1 − e cos M)          ⇒ radial offset  = −a e cos M     amplitude a·e
u = ω + ν ≈ ω + M + 2e sinM ⇒ along-track    =  2 a e sin M
```

| epicycle            | element                                      |
| ------------------- | -------------------------------------------- |
| amplitude `A`       | `e = A / a`                                  |
| phase `φ`           | `ω` (with `M = φ + 90°`)                     |
| centre offset `y_c` | where `ω + M` sits relative to the reference |

Every member shares `a`, `i` and `Ω`. That is not a choice but the bounded-motion condition, and it
is 0010's theorem read at formation scale: freezing the phases wants equal periods, which wants
equal `a`. **The members differ in `e` and `ω` and in nothing else**, so the set of
`(e cos ω, e sin ω)` pairs _is_ the formation — hence the name, and hence no integrator.

### Why the lattice is 1:2 and the extent is a circle

With the bounded velocity field, a member placed at `(pitch·i` radial, `alongPitch·j` along-track)
has amplitude

```
A = √(x₀² + y₀²/4)
```

The `/4` is the epicycle's own axis ratio. An along-track pitch of **exactly twice** the radial one
— and only that — reduces this to `pitch·√(i²+j²)`, making the amplitude bound a _circle_ in lattice
index rather than an ellipse. Suncatcher's 100 m × 200 m is that choice, and its 81 members are
exactly the integer points of a disc of radius 5.

> **The along-track pitch is not a parameter. It is dynamics.**

### Derived quantities and limits

```
cluster size:      |{ (i,j) : i² + j² ≤ rings² }|
cluster radius:    R = 2 · pitch · rings        (radial extent is R/2)
outer member:      e = pitch · rings / a
MAX_ECCENTRICITY        = 0.01   second-order error of the first-order map is A²/a = e·A
MAX_CLUSTER_SATELLITES  = 2000   rings grows the count quadratically — a typo limit
```

**OMM, not TLE**, for a reason that only bites at this scale: the outermost member of Suncatcher
carries `e = 7.1 × 10⁻⁵`, and a TLE's fixed-width eccentricity field would quantise that to about
five metres.

**One epoch and one `MEAN_MOTION` across every member, equal to the last bit.** The sampler anchors
each satellite's grid to its own epoch and steps it at `period / SAMPLES_PER_ORBIT` (120), and
`GridPositionProperty` interpolates between those samples with an error of a few metres — enormous
beside a hundred-metre separation. Identical epochs and mean motions make the grids coincide
exactly, so that error is common-mode and cancels out of every relative quantity, leaving
sub-millimetre differential noise. Staggered epochs would not.

### Measured conclusions

Flown against SGP4 with J₂, the Suncatcher cluster (81 satellites, 650 km, 100 m × 200 m,
`R = 1 km`, `e = 7.1 × 10⁻⁵`) reproduces the paper:

- arrives displaced by up to **8 m** — 8 % of its 100 m spacing. Static, not a drift: measured flat
  over five orbits. It is J₂'s short-period terms sitting between the mean elements that were
  specified and the osculating positions SGP4 reports.
- S1 at `a + R/2` at `3T/12` and `a − R/2` at `9T/12`; nearest neighbours 100–200 m, diagonals
  141–283 m; coplanar to 0.2 m; inside `1.02 R` for a whole orbit.
- the configuration returns to **0.03 m** after one orbit and after five — better than a J₂
  integration of the same design manages, and for the same reason the shared mean motion was chosen:
  what J₂ does to the formation, it does to all of it.

**The shape cycle is a property of the frame.** In the rotating RIC frame a bounded formation sits
inside a fixed ellipse and never leaves it — that is what bounded means. The wide-to-tall-to-wide
deformation is visible only in the _non-rotating_ frame: the RIC basis captured at epoch and held
still. Measuring the shape cycle in the rotating frame is how one concludes, wrongly, that nothing
happens.

---

## Differential drag: which claim survives air

Everything above is secular J₂ in a vacuum. At 550–650 km there is still air,
and two satellites that differ in area-to-mass do not lose altitude at the same
rate — which is a phase difference, and phase differences are what both claims
are made of. `scripts/drag-budget.ts` computes the size of it:

```
ȧ  = −ρ B √(μ a)          B = C_d·A/m
Δs = ¾ · n · ρ ΔB √(μ a) · t²
```

The **t²** is the thing to notice. Every other effect in this file is a rate;
drag makes the separation itself accelerate. Exponential atmosphere, ρ(550 km)
= 2×10⁻¹² kg/m³, H = 65 km, B = 0.11 m²/kg, `ΔB` from a fractional spread
between two members:

| configuration                        | tolerance          | 10% spread | verdict            |
| ------------------------------------ | ------------------ | ---------- | ------------------ |
| cross-shell cluster, 550 km, 48 h    | 121 km (1° of arc) | **28 km**  | holds, 4× margin   |
| cross-shell cluster, 780 km, 48 h    | 125 km             | **0.8 km** | holds, 150× margin |
| cross-shell cluster, 1200 km, 48 h   | 132 km             | **1.2 m**  | holds trivially    |
| Suncatcher lattice, 650 km, 1 orbit  | 100 m (spacing)    | **6.9 m**  | holds              |
| Suncatcher lattice, 650 km, 5 orbits | 100 m              | **173 m**  | **dispersed**      |

Solar activity moves it by an order of magnitude — at solar maximum
(ρ₅₅₀ = 1.5×10⁻¹¹) the 550 km cluster reaches 213 km over 48 h and the lattice
52 m in one orbit. So both claims are conditional on the cycle, the altitude and
the solar epoch, and neither is a free-fall result you can quote unqualified.

**The result worth stating:** differential drag does not care how far apart two
satellites are; the tolerance for "still in formation" does. The tighter the
configuration, the sooner drag — not J₂ — becomes the thing that disperses it.
The two tolerances differ by ~1000× (121 km against 100 m) while the physics is
the same, so the cross-shell claim and the formation claim fail on timescales
~20× apart even at identical ballistic coefficients.

Which is also why the near-polar recommendation above _strengthens_ under drag
rather than weakening: the families that hold ten shells live at 780 km and
above, where the effect is two to three orders of magnitude smaller than at
550 km.

## Open, and deliberately not done

- **Overlap under tolerance is a choice, and arguable.** Returning maximal clusters rather than a
  partition is the honest output; the cost is that one orbit can appear in several clusters and the
  caller has to cope.
- **The output is a Pareto front of size against cycle, not one answer.** A subset that returns
  sooner than the cluster containing it is a different offer, not a worse one. Only a subset that is
  no faster than its container is dropped.
- **`shellPairLayout` needs the cycle budget passed to it.** Two members of a wide family can be 37
  and 47 revolutions apart; under the default 32 it calls them `node-locked` — correct by its own
  definition, misleading about the family they belong to.
- **The 8 m J₂ distortion is measured, not corrected.** Removing it needs a mean-to-osculating
  conversion, which is real work and buys nothing the pictures need. A formation specified as a
  state instead (an integrator's initial conditions) starts exact and acquires the same distortion
  within one orbit.
- **Differential BSTAR is not modelled.** It is exactly how a real cluster disperses, and modelling
  that is a different exercise from drawing the free-fall geometry the design is quoted at.
- **`shellPairLayout` and `findStableClusters` reason about designs, not about a date.** Nothing here
  knows the current epoch; a satellite's actual position comes from SGP4 elsewhere.

## Verifying any of it

```sh
pnpm orbit-lab clusters 550:53,600:97.79,600:97.79,1200:70
pnpm orbit-lab formation 650 100 5
pnpm orbit-lab shells 550 53
```

`scripts/derive-isl-topology.ts` is the same ideas a level deeper — it flies the geometry with SGP4
rather than reading it off a closed form, and is where the measured numbers above come from.

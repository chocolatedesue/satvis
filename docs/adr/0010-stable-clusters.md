---
status: accepted
---

# Stable clusters: the partition orbit space already has, and why it is not a clustering problem

`0009` answered "given this shell, where does a second one go". The question underneath is
structural: **which sets of orbits hold together as a unit, and how do you find them in a fleet
you did not design?** That reads like a clustering problem, and the first instinct — put the
orbital elements in a feature vector and run k-means — is wrong in a way worth writing down,
because the space it would cluster is one whose partition is already known in closed form.

## The derivation

An orbit here is circular and described by four numbers: semi-major axis `a`, inclination `i`,
right ascension of the ascending node `Ω`, and argument of latitude `u` (the angle from the node
to the satellite, which for a circular orbit _is_ the along-track position). Two of those are
constants of the shape and two are angles that run. To secular order in J₂ the angles run at

```
Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i
u̇ = ṁ + ω̇  = n [1 + J₂ (Rₑ/a)² (6 cos²i − 3/2)]
```

and both depend on nothing but `a` and `i`. So the relative motion of two orbits is governed by
exactly two differences: `ΔΩ̇`, which shears their planes apart, and `Δu̇`, which slides their
phases through each other. Everything else about the pair — the initial `Ω` and `u` offsets — is
a constant of the motion, which is why the two rates are the whole story.

Three regimes follow, and they are the classical formation-flying hierarchy read off these two
numbers:

- **`Δa = 0` and `Δi = 0`** — both rates equal identically. Every offset is frozen; the relative
  orbit is bounded and closed at the orbital period. This is the no-drift condition formation
  flying already knows (`δa = 0` is the first thing a relative-orbit-element design imposes),
  and it is what `0009` calls **rigid**.
- **`ΔΩ̇ = 0` and `u̇₁/u̇₂ ∈ ℚ`** — the planes hold their arrangement and the phases return. The
  whole configuration is periodic with the common cycle, which is **repeating**.
- **Anything else** — no relation between the two orbits repeats, ever.

## Decision

**Both conditions are equivalence relations, so orbit space is already partitioned and finding a
cluster is a quotient rather than a search.**

`Ω̇(x) = Ω̇(y)` is equality of a real number: reflexive, symmetric, transitive by inspection. So a
cluster's members do not need checking pairwise — they need only lie on one level set of `Ω̇`,
which is one curve in the (altitude, inclination) plane, `cos i = Ω̇*/K(a)`. **N constraints, not
N².** Commensurability `u̇₁/u̇₂ ∈ ℚ` is an equivalence relation for the same reason multiplication
by a rational is invertible, so "every pair returns" follows from "every member closes one shared
cycle". The intersection of two equivalence relations is one, and its classes are exactly the
maximal stable clusters.

**That is why there is no k to choose.** There is no distance to minimise, no centroid to iterate
and no silhouette to score: a k-means over orbital elements would impose an arbitrary partition
on a space that has a canonical one, and would answer a question about Euclidean proximity in a
space where proximity means nothing — two shells 3 km apart in altitude drift through each other
forever, and two 700 km apart can hold a schedule for years.

**What is left for an algorithm is the part the theory does not survive: tolerance.** No two flown
orbits have exactly equal `Ω̇`, and every real ratio is rational to within any ε, so both relations
must be relaxed before they describe anything real — and **a relaxed equivalence relation is not
transitive**. A within ε of B and B within ε of C leaves A and C 2ε apart. Clusters under tolerance
therefore _overlap_ rather than partition, and the honest output is the set of maximal clusters
rather than an assignment of each satellite to one. `nodeLockedGroups` returns overlapping groups
for this reason, and the tests pin the three-shell case where the middle member belongs to both.

**Both stages are then exact, not approximate:**

1. **Node lock is intervals on a line.** Sort by `Ω̇`; a cluster is a window whose spread is within
   tolerance; the maximal ones are the maximal cliques of an interval graph, which one pass over
   the sorted values enumerates. `O(N log N)`.
2. **The common cycle is simultaneous rational approximation with a budget.** Any cycle `T` is, to
   within the slip tolerance, a whole multiple of every member's period — so enumerating the
   multiples of one member's period up to the budget enumerates every candidate, and each
   candidate _names_ the subset that closes it. Sweeping candidates therefore produces every
   maximal commensurate subset without ever considering a set no cycle supports. `O(N²·K)`, where
   N is the number of distinct orbits rather than satellites.

**The period that matters is the along-track one, `360/u̇`, not the Keplerian one.** They differ by
a part in a thousand, which is 3° of phase after fifteen revolutions — the entire error budget a
cycle has. Anchoring the sweep on `periodMinutes` finds no cluster at all, including the family it
was handed; this is not a hypothetical, it is what the first implementation did.

**The output is a Pareto front of size against cycle, not a single answer.** A subset of a larger
cluster is kept when it comes back _sooner_: shells at 25 and 30 turns of a 47.8 h family return
every 9.56 h between themselves, and a scheduler that only needs two shells should be told the
short number. Only a subset that is no faster than the cluster containing it is dropped.

**Constructing a family is the same statement, written forwards.** `shellFamily` fixes the
reference's revolutions per cycle — which fixes the cycle — and then every other whole number of
revolutions inside the altitude band names one more shell, node-locked to the same curve. Every
pair among them repeats by construction, which is the point of choosing a shared cycle rather than
pairwise ratios: pairwise ratios would need a least common multiple that grows with every shell
added, and a shared cycle does not grow at all.

## Consequences

- **The count is bounded by the band, and the band is bounded by the reference's inclination.** The
  altitude floor and the co-precession ceiling fix a ratio of periods, and the shells are the
  integers that fit inside it — about **one more shell per six hours of cycle** at 550 km.
  `scripts/derive-isl-topology.ts` study 11 measures it:

  | reference      | cycle  | shells | inclination span |
  | -------------- | ------ | ------ | ---------------- |
  | 53° / 550 km   | 23.9 h | 3      | 32.5°–53.0°      |
  | 53° / 550 km   | 47.8 h | 7      | 22.3°–56.1°      |
  | 53° / 550 km   | 71.7 h | 11     | 17.2°–57.1°      |
  | 86.4° / 780 km | 48.6 h | 10     | **83.8°–87.1°**  |

- **The lever is the reference inclination, and it is a large one.** The co-precession ceiling is
  1632 km at 53° and **9407 km at 86.4°**, because matching a node rate near zero costs almost no
  inclination at any altitude. A mid-inclination family is cramped and pays for every extra shell
  in coverage — its top shell at 11 members flies at 17° — while a near-polar family holds ten
  shells inside a 3° spread. **A fleet that wants many stable shells should be near-polar**, and
  the sun-synchronous case is the strongest of all: `Ω̇* = +0.9856°/day` makes every member
  sun-synchronous by construction (asserted in the tests), so the whole family holds a fixed
  local solar time _and_ returns its cross-shell geometry every cycle — a fixed illumination
  geometry and a repeating contact schedule at once, which is exactly what the compute fabric
  needs of a layout.
- **The pairwise verdict needs the cycle budget passed to it.** Two members of a wide family can be
  37 and 47 revolutions apart, and `shellPairLayout` under its default 32-revolution budget calls
  them `node-locked` — correct by its own definition and misleading about the family they belong
  to. It now takes the budget as an argument; a caller that already knows the cycle should say so.
- **Study 12 is the check that matters**: a mixed fleet of twelve orbits — a designed seven-shell
  family, the stacked-shells demo's three, and one shell flown twice — comes back as the family
  whole (plus the sub-families that return sooner) and two `rigid` pairs, with nothing picked for
  coverage joining anything.
- Everything remains secular J₂ on a spherical Earth: no drag, no third body, no station-keeping.
  What it is good for is choosing and recognising layouts, not predicting one.

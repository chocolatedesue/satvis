---
status: accepted
---

# Formations: a cluster is an eccentricity-vector lattice, not an integration

`0009` and `0010` work one scale up — which _shells_ hold a relation to each other, and which
subsets of a fleet return. This one is the scale below: **satellites inside a kilometre of each
other, in one orbit**, which is what Google's Suncatcher design
([arXiv 2511.19468](https://arxiv.org/abs/2511.19468) §2.2) flies 81 of, and what this repository
had no way to express. A Walker pattern's smallest addressable separation is one slot of mean
anomaly — hundreds of kilometres at LEO — because it has no eccentricity to say anything smaller
with.

## The derivation

A formation is usually written in the Clohessy-Wiltshire frame: origin on a reference satellite,
`x` radial and `y` along-track, each member given a relative position and velocity. Bounded motion
is the condition `ẏ₀ = −2n x₀`, and what it produces is an epicycle — each member runs a 2:1
ellipse about its own centre once per orbit:

```
x(t) = A sin(nt + φ)
y(t) = 2A cos(nt + φ) + y_c
```

That description needs an integrator, and reproducing Suncatcher's figure from it means RK4 with
J₂ over 81 bodies. But the same motion is closed form in orbital elements, because **a 2:1
epicycle about a circular reference is a small eccentricity and nothing else**:

```
r = a(1 − e cos M)          ⇒ radial offset = −a e cos M        amplitude a·e
u = ω + ν ≈ ω + M + 2e sin M ⇒ along-track  = 2 a e sin M
```

which is the epicycle, 90° out of phase, to first order in `e`. Reading it as a map:

| epicycle           | element                                     |
| ------------------ | ------------------------------------------- |
| amplitude `A`      | `e = A / a`                                  |
| phase `φ`          | `ω` (with `M = φ + 90°`)                     |
| centre offset `y_c` | where `ω + M` sits relative to the reference |

Every member shares `a`, `i` and `Ω` — that is not a choice but the bounded-motion condition,
and it is `0009`'s theorem read at formation scale: freezing the phases wants equal periods,
which wants equal `a`. **The members differ in `e` and `ω` and in nothing else**, so the set of
`(e cos ω, e sin ω)` pairs _is_ the formation. Hence the name.

Two consequences fall out, and both are why this is worth writing down rather than integrating:

- **J₂ does not disperse it.** Every member shares `a` and `i`, so every member shares `ω̇` and
  `Ω̇`. The whole eccentricity lattice precesses as one and the relative geometry is preserved.
- **The lattice is 1:2 and its extent is circular.** With the bounded velocity field, a member
  placed at `(pitch·i` radial, `alongPitch·j` along-track) has amplitude `√(x₀² + y₀²/4)` — the
  `/4` being the epicycle's own axis ratio. An along-track pitch of exactly twice the radial one,
  and only that, reduces this to `pitch·√(i²+j²)`, making the amplitude bound a _circle_ in
  lattice index. Suncatcher's 100 m × 200 m lattice is that choice, and its 81 members are exactly
  the integer points of a disc of radius 5. **The along-track pitch is therefore not a parameter.
  It is dynamics.**

## Decision

`src/modules/util/clusterFormation.ts` takes four numbers — altitude, inclination, radial pitch,
ring count — and returns one OMM record per lattice point. No integrator, no runtime dependency,
Cesium-free like the rest of that folder. The cluster radius `R = 2·pitch·rings` is derived, as is
the member count.

**OMM, not TLE**, for a reason that only bites at this scale: Suncatcher's outermost member carries
`e = 7.1 × 10⁻⁵`, and a TLE's fixed-width eccentricity field would quantise that to about five
metres. The OMM arm of `GpRecord` carries it as a double.

**One epoch and one `MEAN_MOTION` across every member, equal to the last bit.** Not tidiness:
`sgp4Worker` anchors each satellite's sample grid to its own epoch and steps it at
`period / SAMPLES_PER_ORBIT`, and `GridPositionProperty` interpolates between those samples with
an error of a few metres — enormous beside a hundred-metre separation. Identical epochs and mean
motions make the grids coincide exactly, so that error is common-mode and cancels out of every
relative quantity, leaving sub-millimetre differential noise. Staggered epochs would not.

**Reuse the marked-cluster overlay rather than build a relative-frame view.** The alternative
considered was a live version of Suncatcher's own Fig. 2 — a 2D panel projecting each member into
the reference's frame. What the app already has does the job: every member draws its own orbit
line, `resolveMarks` gives each a halo and its lattice label, and every marked pair is bonded.
Two members of one formation share an altitude _and_ an inclination, so `shellPairLayout` returns
`rigid` with no case of its own, and the bonds are drawn solid. A formation is exactly the
arrangement that verdict was written for and no pair of distinct shells can reach.

The lattice indices stand in for plane and slot — shifted to be non-negative — so the existing
`<plane>-<slot>@<wire>` mark grammar names a member with no new syntax. A cluster member is
markable but not _wirable_: `parseWalkerSatellite` deliberately does not match its name, because
rings and inter-plane links describe a shell, and across a formation every member is already a
neighbour of every other.

## Consequences

**Mean elements in, osculating positions out.** The generator states mean elements; SGP4 reports
osculating ones, and J₂'s short-period terms sit between. They are common-mode to kilometres and
differential to metres: the Suncatcher lattice arrives displaced by up to **8 m**, which is 8 % of
its 100 m spacing. It is static, not a drift — measured flat over five orbits — and a formation
specified as a _state_ instead (an integrator's initial conditions) starts exact and acquires the
same distortion within one orbit. Correcting it means a mean-to-osculating conversion, which is
real work and buys nothing the pictures need. It is measured in the tests rather than hidden.

**Flown, the Suncatcher cluster reproduces the paper.** Against SGP4 with J₂: S1 at `a + R/2` at
`3T/12` and `a − R/2` at `9T/12`, nearest neighbours over 100–200 m and diagonals over 141–283 m
(each end within 15 m, the J₂ distortion above), coplanar to 0.2 m, inside `1.02 R` for a whole
orbit, and the configuration returning to **0.03 m** after one orbit and after five. The
`0.03 m` is better than a J₂ integration of the same design manages, and for the same reason the
shared mean motion was chosen: what J₂ does to the formation, it does to all of it.

**The shape cycle is a property of the frame.** In the rotating RIC frame a bounded formation sits
inside a fixed ellipse and never leaves it — that is what bounded means. The wide-to-tall-to-wide
deformation the paper's figure shows is visible only in the _non-rotating_ frame its caption names:
the RIC basis captured at epoch and held still while the satellite flies on. Measuring the shape
cycle in the rotating frame is how one concludes, wrongly, that nothing happens.
`src/modules/util/relativeFrame.ts` holds both frames and the distinction, and the orbit lab's
**formation view** draws either one live — which is what actually delivers the picture, since the
globe cannot. It propagates the members itself rather than reading the globe's positions, for two
reasons that are the same reason: a formation is defined by its elements. The globe's positions are
Earth-fixed, and an Earth-fixed velocity is the orbital one plus the ground's, which tilts the
along-track axis by about four degrees at 550 km; and a reader of the geometry should not depend on
whether the renderer built a component or which frame a camera mode put the scene in. Twenty-nine
`propagate` calls are microseconds — the coupling would cost more than the arithmetic.

**One thing that looked like a bug and was not.** The first cut of the demo asked for both `Orbit`
and `Illumination arc`, saw `Orbit` missing from the manager's effective components, and recorded it
as a stuck suppression. It is deliberate: the arc *is* the orbit line, cut from the same vertices and
coloured, so `SatelliteManager.reconcile` suppresses the plain one while the arc is on rather than
letting two polylines z-fight on identical geometry. Asking for both is asking for one to be ignored.
Still open, and separate: neither line appears on the globe for a formation's members, where a Walker
pattern's do.

**Scale is the visualisation's whole problem, and the answer is to change it.** At globe range
Suncatcher's kilometre is one point and one orbit line: the geometry is right and there is nothing
to see. `?demo=cluster` therefore flies the same lattice at `R = 120 km`, where the members'
orbit lines separate into a braid, the bonds between them are lines rather than a sub-pixel
smudge, and the 2:1 breathing is a shape. The dynamics are unchanged. `MAX_ECCENTRICITY = 0.01`
is what allows it: the along-track mapping is first order in `e` and its second-order error is
`e·A`, so one percent of the formation's own size is where the drawing stops being of the
formation asked for.

**A formation is a geometry, not a forecast** — the same disclaimer `walkerDelta.ts` carries, and
it binds harder here. No drag term, so no differential ballistic coefficient, which is exactly how
a real cluster disperses and is a different exercise from drawing the free-fall design.

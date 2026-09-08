# From six elements to two rates

Why "which satellites hold together" is a statement about two numbers, and where those two
numbers come from.

`docs/cluster-math.md` is the crib sheet — formulas, thresholds and measured numbers, for a
reader who already agrees with the reduction and wants to look a value up. This file is the step
before it: the same conclusions read off the six classical elements, for someone who knows what
`a`, `e`, `i`, `Ω`, `ω` and `M` are but has not been told why only two of them matter.

`docs/orbital-compute.md` is the step after: given that the geometry is decided by `a` and `i`,
which `a` and `i` you want.

Everything here is secular J₂ two-body on a spherical Earth — long-term averages with the
short-period wobble averaged out. Good for choosing and recognising a layout, not for predicting
one.

---

## 0. What each element is for

| element                 | what it fixes            | in one line                    |
| ----------------------- | ------------------------ | ------------------------------ |
| `a` semi-major axis     | size                     | sets the period, `n = √(μ/a³)` |
| `e` eccentricity        | shape                    | how far from circular          |
| `i` inclination         | tilt                     | how far off the equator        |
| `Ω` right ascension     | which way it tilts       | the plane's orientation        |
| `ω` argument of perigee | where the ellipse points | in-plane orientation           |
| `M` mean anomaly        | where you are            | how far along the track        |

Five of them describe the orbit; the sixth says where on it the satellite currently is.

## 1. A compute constellation is circular, so six becomes four

Every design in this repository is near-circular, because a compute cluster wants a constant
altitude and a constant lighting geometry. At `e ≈ 0` the ellipse degenerates: **perigee has no
location**, so `ω` stops being meaningful on its own and merges with `M` into one angle measured
from the ascending node:

```
u = ω + ν        (argument of latitude: along the track, from the node)
```

Six elements, four concepts: **`a` (how big), `i` (how tilted), `Ω` (tilted which way), `u` (how far
round)**.

## 2. Two of them run, and two do not

To secular order, `a` and `i` are constants of the motion. `Ω` and `u` are angles that advance at a
steady rate. So the relation between two orbits is carried entirely by

```
ΔΩ̇   how fast their planes shear apart
Δu̇   how fast their phases slide through each other
```

and the starting offsets `Ω₀` and `u₀` are just constants that turn the picture. They decide what
the configuration looks like _now_; they cannot decide whether it comes back, because they never
change.

That is the whole reduction, and everything else in the cluster code is arithmetic on top of it.

## 3. Where `Ω̇` comes from

The Earth is not a sphere. It has an equatorial belt of surplus mass, and that belt pulls harder on
the parts of a tilted orbit that dip towards it. Averaged over one revolution the pull is not
central: it leaves a **torque** on the orbit.

An orbit is a gyroscope — its angular momentum `L` points along the orbit normal — and a torque
perpendicular to `L` does not tilt a gyroscope, it makes it precess: `dL/dt = τ`. The plane swings
around the Earth's axis instead of falling over. Averaging the bulge's torque over one revolution
gives

```
Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i
```

Read the three factors off the physics, not the formula:

- `(Rₑ/a)²` — the bulge is a fixed size; the higher you fly, the weaker its grip.
- `cos i` — **a polar orbit does not precess at all.** Its plane passes over both poles, so the
  equatorial belt is symmetric about it and the net torque is zero. Prograde orbits (`i < 90°`)
  regress, sun-synchronous ones (`i > 90°`) advance.
- the sign — a prograde node walks west.

## 4. Where `u̇` comes from

The along-track angle is not the Keplerian mean anomaly; it is the mean anomaly plus the perigee's
own rotation, and J₂ moves both:

```
Ṁ = n [1 + (3/2) J₂ (Rₑ/a)² (1 − (3/2) sin²i)]
ω̇ =     (3/4) J₂ n (Rₑ/a)² (5 cos²i − 1)

u̇ = Ṁ + ω̇ = n [1 + J₂ (Rₑ/a)² (6 cos²i − 3/2)]
```

**Use `u̇`, never the Keplerian period.** They differ by about a part in a thousand, which is 3° of
phase after fifteen revolutions — the entire error budget a repeat cycle has. Anchoring the
resonance search on `periodMinutes` finds no cluster at all, including the family it was handed.
That is not a hypothetical warning; it is what the first implementation did.

## 5. Two conditions, and why "rigid" is unavailable across shells

| condition                  | what it buys                                              |
| -------------------------- | --------------------------------------------------------- |
| `ΔΩ̇ ≈ 0`                   | the planes stop shearing — the crossing seam stays put    |
| `Δu̇` a small-integer ratio | the phases close, so the configuration returns on a cycle |

Both together and the layout **returns** periodically. Both at zero and nothing moves at all — but
that is not a second shell:

> Freezing the phases wants an equal period, which wants an equal semi-major axis. Freezing the
> planes wants an equal node rate, which at equal `a` wants an equal `i`. Both at once is the same
> shell. **No two distinct shells can be rigid**, so a multi-shell layout is designed for return
> rather than stillness.

The relaxed version of the two conditions is where the tolerance thresholds and the five verdicts
come from — `rigid`, `repeating`, `phase-locked`, `node-locked`, `drifting` — and those are tabulated
in `docs/cluster-math.md`.

## 6. Why proximity is not a criterion

Two clock hands: how far apart they are now is a phase offset, and it is a constant. Whether they
ever line up again depends only on the difference of their rates.

Orbits work the same way. The **distance** between two satellites is set by the constant offsets
`Ω₀` and `u₀`; it oscillates inside an envelope and does not degrade. What degrades — what time
acts on at all — is whether the pattern returns. Hence the two facts that make element-space
clustering the wrong tool:

- two shells 3 km apart in altitude drift through each other forever;
- two shells 700 km apart can hold a schedule for years.

There is no `k` to choose, no centroid to iterate and no distance to minimise. A member does not
need checking against its neighbours; it needs to lie on one level set of `Ω̇`, which is one curve
in the (`altitude`, `inclination`) plane. **N constraints, not N²** — the point of
`docs/adr/0010-stable-clusters.md`.

## 7. The same reduction, one kilometre wide

Shrink the scale and not one line changes. Inside a single orbit, bounded relative motion asks for

- `δa = 0` — equal periods, or the along-track offset grows linearly and never comes back;
- equal `i` and `Ω` — the same plane;

which leaves exactly two degrees of freedom, `e` and `ω`. Written as a vector,
`(e·cos ω, e·sin ω)`, that **is** the formation: one point per satellite, no integrator. Two
consequences fall straight out of `r = a(1 − e cos M)` and `u ≈ ω + M + 2e sin M`:

- the along-track amplitude is **twice** the radial one, so a lattice pitch of 1:2 is the only one
  whose extent is a circle in lattice index rather than an ellipse — dynamics, not a parameter
  (`docs/adr/0012-orbit-formations.md`);
- the outermost member of a 1 km cluster carries `e ≈ 7×10⁻⁵`, which a TLE's fixed-width field
  quantises to about five metres. At this scale the element set has to be an OMM.

## 8. Two knobs, one curve

Both rates are functions of `a` and `i` and nothing else, so choosing an orbit is choosing two
numbers. Setting `Ω̇₂ = Ω̇₁` and solving for the companion's inclination gives the whole family of
shells that hold their planes against the reference:

```
cos i₂ = cos i₁ · (a₂/a₁)^(7/2)
```

Two readings of it, and both are design levers:

- **the higher the companion, the shallower it must fly** — the lock is paid for in inclination;
- the curve ends at the **co-precession ceiling** `a₁·|cos i₁|^(−2/7) − Rₑ`: 1632 km for a 53° /
  550 km shell, **9407 km at 86.4°**, because matching a node rate near zero costs almost no
  inclination. A fleet that wants many stable shells should be near-polar.

And one free result: if the reference is sun-synchronous (`Ω̇* = +0.9856 °/day`), **every member of
the family is sun-synchronous by construction** — a fixed local solar time and a repeating
cross-shell geometry, from one condition (`?demo=sso-family`, `docs/orbital-compute.md`).

---

## Where to go next

- `docs/cluster-math.md` — the formulas, the thresholds and the measured numbers.
- `docs/adr/0010-stable-clusters.md` — why the two conditions are equivalence relations, and what
  tolerance does to that.
- `docs/adr/0012-orbit-formations.md` — the same theorem at formation scale.
- `docs/adr/0013-orbit-model.md` — why an orbit has two faces here: a design (`a`, `i`) and a
  propagated element set.

## Reproducing any of it

```sh
pnpm orbit-lab orbit 550 53                        # the two rates for one shell
pnpm orbit-lab shells 780 86.4                     # what other shells can hold against it
pnpm orbit-lab clusters 550:53,600:97.79,1200:70   # given a fleet, which subsets return
pnpm orbit-lab design 550 53 22                    # geometry, energy and inference together
```

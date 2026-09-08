# Cluster maths from scratch

The two things this repository calls a cluster live at scales a thousand apart, and each has its own
short derivation. Both come down to the same observation: **relative motion is a difference** — a
difference in elements inside one orbit, a difference in rates between two.

This file derives both, starting from a near-circular orbit and assuming nothing but the six
elements. It carries no measurements: every number here is one a reader can reproduce in a line.
[`cluster-math.md`](cluster-math.md) holds the measured figures and thresholds;
[`elements-to-clusters.md`](elements-to-clusters.md) holds the reduction of the six elements to the
two rates that matter. Read this one first when the derivation itself is what is new.

| scale                                                           | who moves relative to whom               | the mathematics                        | what differs              |
| --------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- | ------------------------- |
| **formation** — metres to a kilometre, one orbit                | a member against the reference satellite | a small eccentricity is a 2:1 epicycle | the **elements** `e`, `ω` |
| **stable cluster** — hundreds to thousands of km, across orbits | one orbit against another                | the two secular rates `Ω̇`, `u̇`         | the **rates** themselves  |

---

## 1. Where a near-circular satellite is

Six elements: `a` size, `e` shape, `i` tilt, `Ω` node, `ω` perigee, `M` mean anomaly — how far round
it has gone, which grows linearly in time.

For `e` small enough that `e²` is noise — a formation's outermost member carries `e ≈ 7 × 10⁻⁵` —
position collapses to two expressions:

```
radial distance   r = a (1 − e cos M)      ⇒  radial offset from a circle = −a e cos M
along-track angle u = ω + M + 2 e sin M    ⇒  along-track offset        = a · 2e sin M
```

The `2` in the second line is the first-order solution of Kepler's equation (true anomaly
`ν ≈ M + 2e sin M`). **That factor of two is where everything below comes from.**

---

## 2. Formations: a small eccentricity _is_ a 2:1 epicycle

Take a circular reference and a member carrying a small `e`, and read `M` as time:

```
x(t) = −A cos M        radial,      amplitude A  = a e
y(t) = +2A sin M       along-track, amplitude 2A = 2 a e
```

Eliminating `M`:

```
x²/A² + y²/(2A)² = 1
```

Each member runs a **2:1 ellipse about its own centre, once per orbit** — the epicycle. Along-track
is twice radial, always.

### The size of a formation is one number, and that number is `e`

At `h = 650 km`, `a = 6378.135 + 650 = 7028.1 km = 7.0281 × 10⁶ m`:

| epicycle amplitude `A`        | required `e = A / a` |
| ----------------------------- | -------------------- |
| 100 m                         | `1.423 × 10⁻⁵`       |
| 500 m (5 rings × 100 m pitch) | `7.114 × 10⁻⁵`       |
| 1000 m                        | `1.423 × 10⁻⁴`       |

So a formation is sized by choosing an eccentricity, in closed form, with no integrator.

### The same result the other way round

The textbook route is Clohessy–Wiltshire, with `x` radial and `y` along-track:

```
ẍ − 3n²x − 2nẏ = 0
ÿ + 2nẋ = 0
```

Integrating the second gives `ẏ = −2n x + C`, `C = ẏ₀ + 2n x₀`. Substituting back makes `x` a pure
oscillator plus a constant, and integrating `ẏ` once more turns that constant into a **linear drift**
`−3C t` along the track. So the motion is bounded exactly when

```
C = 0   ⟺   ẏ₀ = −2 n x₀
```

and what is left is `x = A sin(nt + φ)`, `y = 2A cos(nt + φ) + y_c` — the same 2:1 epicycle. The
element form states it in one line; the integration takes a page and an integrator once J₂ is in.
That is the whole argument for treating a formation as a lattice rather than as an initial-value
problem.

### The lattice, and why the along-track pitch is twice the radial one

Place a member at `(x₀, y₀)` with its epicycle centre on the reference, and its amplitude follows
from the two expressions above:

```
A = √( x₀² + y₀² / 4 )
```

The `/4` is the epicycle's own axis ratio, squared. Lay the members out on a lattice with radial
pitch `p` and along-track pitch `q`, so `x₀ = p·i` and `y₀ = q·j`:

- `q = p` gives `A = p√(i² + j²/4)` — the amplitude bound is an **ellipse** in lattice index;
- **`q = 2p` gives `A = p√(i² + j²)` — a circle.**

Only the second is isotropic, so the along-track pitch is not a parameter to tune. It is the
epicycle's shape. A lattice of `rings` then has

```
outer amplitude  A_max = p · rings   ⇒   e_max = p · rings / a
cluster radius   R     = 2 · A_max = 2 · p · rings
```

`R` carries the same factor of two: the formation reaches twice as far along the track as it does
radially.

---

## 3. Why J₂ leaves the lattice alone

The Earth's oblateness contributes two secular rates — rates that accumulate rather than oscillate:

```
Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i                      the node precesses
u̇ = n [1 + J₂ (Rₑ/a)² (6 cos²i − 3/2)]             the satellite runs round its own orbit
```

Both are functions of `a` and `i` alone; `e` enters only at second order, and a formation's `e` is
`10⁻⁵`. Members of one formation **share `a` and `i`** — that is the bounded-motion condition, not a
choice — so every member shares `Ω̇` and `u̇`, and:

> the whole eccentricity lattice precesses as one piece, and the relative geometry is conserved.

What J₂ does to the formation, it does to all of it. That is why a formation returns to its own shape
after an orbit, and why the generator pins one epoch and one mean motion across every member: the
sampler's interpolation error then becomes common mode and cancels out of every relative quantity.

---

## 4. Across shells: two rates, and only their differences

Now compare two circular orbits. Their relative motion is governed by exactly two secular
differences, and each accumulates linearly:

```
ΔΩ(t) = ΔΩ₀ + ΔΩ̇ · t        the planes shear apart
Δu(t) = Δu₀ + Δu̇ · t        the phases slide apart
```

which gives three verdicts and no fourth:

| condition                           | verdict     | meaning                         |
| ----------------------------------- | ----------- | ------------------------------- |
| `ΔΩ̇ = 0` and `Δu̇ = 0`               | `rigid`     | the relative geometry is frozen |
| `ΔΩ̇ = 0`, `Δu̇` a whole-number ratio | `repeating` | everything returns every `T`    |
| otherwise                           | `drifting`  | it never comes back             |

The closure condition is `T · Δu̇ = 360° × k` for some whole `k` — the two orbits turn `k` times
differently in one cycle.

### Locking the planes, in closed form

Since `n ∝ a^(−3/2)`, the node rate goes as `Ω̇ ∝ a^(−7/2) cos i`. Setting two of them equal solves
the companion's inclination for its altitude:

```
cos i₂ = cos i₁ · (a₂/a₁)^(7/2)
```

`|cos i₂| ≤ 1` bounds how high a companion can go and still keep up — the **co-precession ceiling**:

```
a₂ ≤ a₁ |cos i₁|^(−2/7)      ⇒      altitude ceiling = a₁ |cos i₁|^(−2/7) − Rₑ
```

Because `cos i` shrinks near the pole, that ceiling rises steeply with inclination: 1632 km for a
53° / 550 km reference, 9407 km at 86.4°. Inclination is the lever on how many shells a family can
hold.

### Why no two distinct shells are rigid

Freezing the phases wants equal `u̇`, which wants equal altitude. Freezing the planes wants equal
`Ω̇`, which at equal altitude wants equal inclination. Both at once is one shell, not two. So across
shells, _stable_ can only ever mean **periodic** — never still.

### Both conditions are equivalence relations, and that settles the algorithm

"Same `Ω̇`" and "rational ratio of `u̇`" are each reflexive, symmetric and transitive. Transitivity
means orbit space is **already partitioned**: finding the stable clusters is taking a quotient, so `N`
shells cost `N` constraints rather than `N²`, and there is no `k`, no centroid and no distance —
which is why clustering by proximity in element space is the wrong shape of answer here.

Tolerance breaks transitivity: `A` may tolerate `B` and `B` tolerate `C` while `A` and `C` do not.
Clusters under tolerance therefore **overlap** rather than partition, and the honest output is a
front of size against cycle rather than a single grouping.

---

## 5. Drag: the only term with a `t²`

Everything above is a rate. Differential drag is not:

```
ȧ  = −ρ B √(μ a)              B = C_d · A/m
Δs = ¾ · n · ρ · ΔB · √(μ a) · t²
```

with `ΔB` the spread in ballistic coefficient between two members. The `t²` makes the separation
itself accelerate, which is why the timescales separate so sharply: five orbits cost twenty-five
times one orbit, so a drift that is 6.9 m after one orbit is 173 m after five.

The consequence worth carrying: **drag does not care how far apart two satellites are, and the
tolerance for "still in formation" does.** A cross-shell cluster tolerates ~121 km; a lattice
tolerates 100 m. Same physics, a thousand-fold difference in tolerance, and failure times about
twenty-fold apart. [`cluster-math.md`](cluster-math.md) tabulates it.

---

## 6. The two scales, side by side

|                     | formation (inside one orbit)           | stable cluster (across orbits)             |
| ------------------- | -------------------------------------- | ------------------------------------------ |
| what differs        | the elements `e`, `ω`                  | the rates `Ω̇`, `u̇`                         |
| shape of the motion | a 2:1 epicycle, once per orbit         | linear shear and slip                      |
| what holds it       | shared `a`, `i` ⇒ shared `Ω̇`, `u̇`      | a designed `cos i₂` and integer turn ratio |
| stability           | absolute, in free fall                 | **periodic**, never still                  |
| what breaks it      | differential drag, in orbits           | drag with 4–150× margin                    |
| derived in          | `src/modules/util/clusterFormation.ts` | `src/modules/util/shellLayout.ts`          |

The two are the same sentence read at different scales: relative motion is a difference — of
elements, which oscillates, or of rates, which accumulates.

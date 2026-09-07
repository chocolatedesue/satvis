# Synthesising an orbital compute cluster

How to choose an orbit for a cluster that runs AI, and what the three layers — geometry,
energy, inference — each take away from that choice. Every number below is produced by the
functions the app itself runs, and every one is reproducible:

```sh
pnpm orbit-lab design 550 53 22      # one orbit, all three layers at once
pnpm orbit-lab shells 780 86.4       # companion shells that hold
scripts/drag-budget.ts               # how long the vacuum holds
pnpm energy-report                   # docs/starlink-energy-report.md, regenerated
```

This file is the synthesis. The derivations live in `docs/cluster-math.md` (geometry and
drag), `docs/starlink-energy-report.md` (energy, measured over real shells) and
`docs/adr/0010`, `0012` (why the two things called a cluster are built the way they are).

---

## The three layers, and what each one forbids

A cluster that computes is not one design problem but three, stacked:

| layer         | question                                            | what it forbids                        |
| ------------- | --------------------------------------------------- | -------------------------------------- |
| **geometry**  | will the satellites hold their relative arrangement | links that only exist for a moment     |
| **energy**    | how much of each orbit is there power               | compute that stops a third of the time |
| **inference** | how deep can the model be cut                       | a pipeline deeper than the sunlit arc  |

They are usually designed separately. They should not be, because **the altitude and
inclination that are best for one are the same ones that are best for the other two** —
which is the main finding here, and is not what you would guess.

---

## Layer 1 — geometry

Two secular rates decide everything, and both are functions of `a` and `i` alone:

```
Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i
u̇ = ṁ + ω̇ = n [1 + J₂ (Rₑ/a)² (6cos²i − 3/2)]
```

A configuration holds when **the node rates agree** and **the along-track rates are in a
whole-number ratio**. Both are equivalence relations, so orbit space is already partitioned
and finding the clusters is a quotient, not a search (`docs/adr/0010`).

- companion inclination, in closed form: `cos i₂ = cos i₁ · (a₂/a₁)^(7/2)`
- the ceiling past which no companion can match: `a₁·|cos i₁|^(−2/7) − Rₑ`
- ring links clear the Earth only when `a·cos(π/S) > Rₑ + 80 km`

**The lever is inclination, and it is a large one.** The co-precession ceiling is 1632 km at
53° and 9407 km at 86.4°, so a near-polar reference admits far more shells; the measured
families hold ten shells inside a 3° inclination spread where a 53° family's eleventh has
fallen to 17°.

---

## Layer 2 — energy

One angle governs it: **β**, the sun's elevation above the orbit plane. An orbit is
eclipse-free exactly when

```
|β| ≥ arcsin(Rₑ/(Rₑ+h))
```

and is eclipsed about a third of every revolution when β is small. Three knobs move β, and
they are not equally powerful:

| knob        | what it does                                | worth                              |
| ----------- | ------------------------------------------- | ---------------------------------- |
| node vs sun | picks β within the range inclination allows | **free** — same launch, same orbit |
| inclination | raises the ceiling on β one-for-one         | 1° ≈ 51 km of altitude at 550 km   |
| altitude    | lowers what the shadow demands              | ~0.02°/km — the weak knob          |

Measured over the gen-1 Starlink filing (4408 satellites, `pnpm energy-report`):

- every shell's reachable β **exceeds** the β it needs — so some planes are never eclipsed
  while others in the same shell lose a third of every orbit
- the fleet aggregate is almost flat (29–31% eclipsed, year round) but the **per-plane spread
  is 0%–37%** — all of the available win is in plane-level placement, none in fleet timing
- a host, started while powered, goes dark after **p50 1540 s** at 550 km / 53°
- every satellite loses power once per revolution, so forced migrations arrive at
  **15 per satellite per day** — one every **3.6 s** somewhere in a 1584-satellite shell

The static-assignment lesson: at 53° / 550 km the node regresses 4.5°/day against the sun's
1°/day, so each plane's energy budget rotates with a **66-day** period and any fixed
assignment goes stale in weeks. At 97.6° the node drift is +0.98°/day — accidentally
sun-synchronous — and the budget becomes a standing property of the plane instead.

---

## Layer 3 — inference

A decode pipeline is cut into `P` stages, one per satellite, connected by inter-satellite
links. **It produces tokens only while every stage has power simultaneously** — a conjunction,
not an average. That gives two closed forms (`src/modules/util/energyTrace.ts`):

```
P* = ⌊N (1 − f_ecl)⌋                          optimal depth = the lit arc
p_full(P) = max(0, (1 − f_ecl) − (P−1)/N)     share of time all P stages are lit
```

`P*` is a **cliff, not a slope**: past it the served fraction does not taper, it collapses.
Measured on 550 km / 53° with N = 22:

| P            | all stages lit |
| ------------ | -------------- |
| 1            | 68.5%          |
| 4            | 54.9%          |
| 8            | 36.7%          |
| **15 = P\*** | 4.9%           |
| 16           | **0.3%**       |

And `P*` is not one number per shell. Across the planes of a single shell, on a single day,
it runs **13 to 22** — because `f_ecl` does. A depth chosen for the shell average is past the
cliff on the worst planes and leaves throughput on the table on the best.

**Handoff costs.** A stage's KV working set is ~2 GB; one ISL at 100 Gbps serialises it in
**160 ms**. The warning before an eclipse is p50 3050 s, so time is never the binding
constraint — **the churn rate is**. Incremental sync (ship only the KV growth since the last
transfer, ~25.6 MB per simulated second) turns a gigabyte-scale migration into hundreds of
megabytes.

**The Earth is opaque.** A chord through the planet is not a long link, it is no link. A
handoff therefore goes to a host the current one can _see_, and when none is visible it goes
**around the limb** through a lit relay — charged for the whole wire.

---

## The synthesis: all three layers point the same way

Running `pnpm orbit-lab design` on three candidates, each at its natural ring size:

|                       | 550 km / 53° | **780 km / 86.4°** | 650 km / 97.99° |
| --------------------- | ------------ | ------------------ | --------------- |
| eclipse fraction      | 31.5%        | **25.9%**          | 27.4%           |
| planes never eclipsed | 5.6%         | **22.4%**          | 17.8%           |
| `P*`                  | 15 of 22     | **22 of 30**       | 14 of 20        |
| co-precession ceiling | 1632 km      | **9407 km**        | 5973 km         |
| β cycle               | 66 days      | 257 days           | frozen (SSO)    |
| drag, 1 h, 10% spread | 12.3 m       | **0.3 m**          | 2.6 m           |

**Near-polar wins on all three layers at once**, and by a wide margin on each: four times as
many never-eclipsed planes, six times the ceiling on how many shells can hold, forty times
less differential drag. There is no trade to make here. The usual expectation — that you pay
for stability with coverage, or buy power with latency — does not hold between 550 and
780 km, because the same term (`cos i`) that flattens the node rate also raises β and, at
higher altitude, thins the air.

The one real cost of going up is latency and radiation, and this model knows nothing about
either.

### Drag is the constraint that separates the two kinds of cluster

```
Δs = (3/4) · n · ρ ΔB √(μ a) · t²
```

The **t²** is the character of it: every other effect in the model is a rate, and this one's
growth is itself a growth. Because drag does not care how far apart two satellites are while
"still in formation" does, the two cluster claims fail on very different timescales at
identical ballistic coefficients:

| configuration                | tolerance          | 10% spread | verdict            |
| ---------------------------- | ------------------ | ---------- | ------------------ |
| cross-shell, 550 km, 48 h    | 121 km (1° of arc) | 28 km      | holds, 4× margin   |
| cross-shell, 780 km, 48 h    | 125 km             | 0.8 km     | holds, 150× margin |
| Suncatcher lattice, 1 orbit  | 100 m (spacing)    | 6.9 m      | holds              |
| Suncatcher lattice, 5 orbits | 100 m              | 173 m      | **dispersed**      |

So: the **cross-shell** result is robust to the dominant unmodelled perturbation, and the
**formation** result is not — it needs a delta-v statement before it is an operational claim.
That is exactly what Google's Suncatcher paper does (citing D'Amico: "modest delta-v
requirements beyond what would be needed for precise station-keeping of a single satellite").
Our measured 0.03 m return after one orbit is a **free-fall** property, not an operational
one, and should be quoted as such.

---

## A design procedure

1. **Pick the altitude and inclination for energy first.** The annual never-eclipsed table in
   `docs/starlink-energy-report.md` is the table to design against: it depends on nothing but
   altitude, inclination and date. Spend inclination before altitude — below ~45° at LEO
   nothing is ever eclipse-free.
2. **Fix the node phase for free.** Once the shell exists, which planes are in their sunlit
   season is a choice about where the node sits relative to the sun, and it costs nothing.
3. **Then ask how many shells can hold.** `pnpm orbit-lab shells <alt> <inc>`; the count is
   bounded by the co-precession ceiling, and that ceiling is set by the inclination you just
   chose.
4. **Size the pipeline to the lit arc, per plane.** `P* = ⌊N(1−f_ecl)⌋`, not to the shell
   average — `f_ecl` varies enough across planes that the average is past the cliff somewhere.
5. **Choose the cluster scale last.** Hundreds of kilometres apart (a shell) if you want the
   geometry to survive without thrust; metres to a kilometre (a formation, `docs/adr/0012`) if
   you want the link budget, and then budget the station-keeping.
6. **Check the drag budget before quoting a cycle.** `scripts/drag-budget.ts`.

---

## What is still open

- **No battery, no panel area, no thermal model, no power policy.** The illumination facts
  here are what a power budget is built _on_, not the budget.
- **No attitude.** κ assumes a zenith panel on a nadir-pointing bus; a sun-tracking panel
  reads much better and no element set says which.
- **Drag is an order-of-magnitude law**, not a forecast: exponential atmosphere, fixed
  ballistic coefficients, no attitude, solar activity as a single density. Solar maximum moves
  every drag figure by ~7×.
- **The 0.03 m formation return and the 99.7% partner-retention figure are free-fall
  results.** Neither survives contact with station-keeping or differential drag unqualified.
- **Nothing here models the compute** — FLOPs per watt, memory bandwidth, the model-parallel
  split, or what a 160 ms handoff does to a decode loop's latency budget.

# How far is the satellite that takes over?

When a host goes dark the workload has to go somewhere. **Where — and how long before that one
goes dark too.**

`docs/starlink-energy-report.md` answers how much of an orbit has power.
`src/modules/util/migration.ts` answers where a KV cache goes on this frame. Neither answers
the question between them, which is the one a hand-off budget is built on. This file does, by
propagation:

```sh
node --experimental-strip-types scripts/research/migration-reach.ts        # every sweep
node --experimental-strip-types scripts/research/migration-reach.ts load   # fleet-wide rate and bandwidth
node --experimental-strip-types scripts/research/migration-reach.ts power  # panel vs eclipse
node --experimental-strip-types scripts/research/migration-reach.ts season # four dates
```

Same SGP4 the app flies, same ν/κ channels the globe is painted with (`illuminationOf`), same
line-of-sight rule and around-the-limb routing the hand-off actually takes (`hasLineOfSight`,
`routesFrom`). The script asserts its own fast path against `chooseRouteExcluding` on every
run, so these are the app's policy rather than a second implementation of it.

---

## Three answers, in order of how much they move the number

The eclipse fraction is not one of them. Every 53° row below sits at 33.6% eclipsed and 46%
unpowered, and the hand-off distance still ranges over a factor of six. What moves it:

1. **How much remaining sunlight you demand of the target** — 1274 km at zero, 7979 km at
   1800 s. A factor of six.
2. **Inclination** — 1274 km at 53°, 506 km at 97.6°, and at 87.9° the demand becomes free.
3. **Which link fabric the hand-off is allowed to use** — the direct chord, or a walk across
   the ISL lattice the app actually draws. A factor of four in transfer time, and it is the
   one nobody budgets for.
4. **Which satellite you hand to** — nearest lit, several slots back round your own ring, or
   the one with the most sunlit arc left. Handing to the freshest sunlit satellite cuts the
   migration rate from 32.2 to **1.9 per orbit**, the theoretical floor, for the same bytes.

Bandwidth is not on the list: the busiest policy measured occupies 0.21% of one ISL, and along
the efficient frontier the bytes are conserved no matter which rule you pick. Nor is placement:
at whole-constellation scale, greedy local rules run the fleet to its arithmetic ceiling and a
scheduler buys under a percentage point.

Density (T, P, S) sets a floor under the first and does nothing to the rest.

---

## The base case

53° / 550 km, 10 planes × 22, at the instant a host loses power. p50 over 636 eclipse entries,
3 revolutions at 20 s steps, March equinox.

| the target must stay lit | nearest such satellite | legs | free-space transfer | over the fixed ISL lattice |
| ------------------------ | ---------------------- | ---- | ------------------- | -------------------------- |
| ≥ 0 s (just lit now)     | **1274 km**            | 1    | 0.164 s             | 4 hops, 0.64 s             |
| ≥ 180 s                  | 1598 km                | 1    | 0.165 s             | 5 hops, 0.80 s             |
| ≥ 600 s                  | 3467 km                | 1    | 0.172 s             | 2 hops, 0.32 s             |
| ≥ 1200 s                 | 5505 km                | 2    | **0.338 s**         | 6 hops, 0.96 s             |
| ≥ 1800 s                 | 7979 km                | 2    | 0.347 s             | 6 hops, 0.96 s             |

**At zero demand the hand-off is one lattice step.** 1274 km, against a median
nearest-neighbour spacing of 873 km and a ring chord of 1972 km. This holds across every
pattern measured — 428–1428 km, **always a single leg, never relayed, never stranded**. The
naive model's old through-the-Earth chords of 8149–11 215 km (`docs/adr/0011`) were never the
geometry; they were the bug.

**Demanding dwell is what costs.** 1274 → 3467 → 7979 km for 0 / 600 / 1800 s. A target that
must still be lit half an hour from now is most of the way to the sub-solar side, and past
5053 km at this altitude there is no direct link at all (`maxLinkRangeKm`) — which is the
1-leg → 2-leg step in the table.

**The cost of distance is hops, not light.** 2 GB over 100 Gbps is 160 ms of serialisation;
1274 km of light is 4.2 ms and 7979 km is 26.6 ms. Distance is nearly free right up to the
horizon and then costs a whole second serialisation, because a relay receives the entire cache
before forwarding it (`routeTransferCost`). The curve is flat, flat, flat, **+160 ms**.

---

## The hand-off does not go to your neighbour

Median Δplane at zero demand is **4**, in a 10-plane pattern. Not 1. The pattern holds across
the sweep: the target sits roughly 0.4 P planes away — 7 of 20, 8 of 20, 3 of 10 — which is
something like 140° of right ascension.

That is the mechanism behind everything else here. Two 53° planes 144° apart in RAAN
*intersect*, so satellites from them pass close; and because their nodes are far apart their β
differs, so they are at different points in their own sunlit arcs. **Far in RAAN is what
decorrelates the sun phase, and plane crossings are what make far-in-RAAN geometrically near.**
Your actual nearest neighbour is no use to you: it is crossing the same terminator you are.

Which is why the naive policy churns, and the exception proves the rule:

| policy                | hand-off p50 | target dwell p50 | target dark < 60 s |
| --------------------- | ------------ | ---------------- | ------------------ |
| naive (reactive, 0 s) | 1279 km      | **140 s**        | **20%**            |
| predictive 90 s       | 988 km       | 200 s            | 0%                 |
| predictive 300 s      | 1066 km      | 460 s            | 0%                 |
| predictive 600 s      | 954 km       | 900 s            | 0%                 |

A naive hand-off is the first of a chain, not a fix: its median target is itself dark 140 s
later, and the dark arc is ~2640 s at 550 km. And predicting 90 s ahead is cheaper **in
distance as well as in stalls** — 988 against 1279 km — because deciding before the terminator
means the near satellites have not yet turned into the ones going dark with you.

Do not read that table as a cost curve, though. A lookahead window moves two things at once: it
decides *earlier*, when the whole neighbourhood is still lit, and it demands *more* of the
target. Those push opposite ways, which is why the column does not order, and why the dwell
table above — decision instant fixed, demand varied — is the one to budget from.

---

## The link fabric is worth as much as the geometry

The migration model routes over the **visibility graph**: any two satellites that can see each
other are one hop apart. The topology the app draws is not that graph —
`constellationLinks.ts` wires a ring inside each plane and a same-slot link between *adjacent*
planes, and nothing else (`docs/adr/0008`). A fleet whose radios are installed that way cannot
take the direct chord to a satellite four planes over, however clearly it can see it. It has to
walk, and every step is a store-and-forward leg.

At the base case that is **4 hops and 0.64 s against 1 hop and 0.164 s — 3.9×**, for the same
hand-off, between two assumptions that are both defensible.

And it inverts the density conclusion. At fixed N = 220, priced over the fixed lattice:

| shape                     | reach ≥ 0 s | free space  | over the lattice    |
| ------------------------- | ----------- | ----------- | ------------------- |
| 5 planes × 44 (long rings) | 989 km      | 1 leg, 0.163 s | **1 hop, 0.16 s** |
| 10 × 22 (square)          | 1274 km     | 1 leg, 0.164 s | 4 hops, 0.64 s      |
| 20 × 11 (short rings)     | 1008 km     | 1 leg, 0.163 s | 5 hops, 0.80 s      |

In the 5 × 44 pattern the hand-off goes to the next satellite in the *same ring* — 989 km is
the ring chord to within a kilometre — which is one hop on a link that already exists and never
changes length (`CV ≈ 0.001`, `derive-isl-topology.ts`). Free space cannot tell these three
patterns apart. The lattice says one of them is four times cheaper.

The caveat is that this only holds at low demand: at ≥ 600 s the same 5 × 44 pattern is the
*worst* of the three over the lattice (11 hops, 1.76 s), because a deeply-lit target is far
along-track and a long ring is many ring steps. Long rings make cheap reactive hand-offs and
expensive predictive ones.



---

## Residence is the quantity being bought

A hand-off does not buy distance. It buys **residence** — the target's remaining sunlit arc —
and that reframes every table above, because it puts a ceiling on what any hand-off can
achieve and a floor under how often you must repeat it.

At 53° / 550 km, measured over interior runs only (a run still open when the window closes is
a measurement of the window, not of the orbit):

| arc            | p50      | p10  | p90  | across planes |
| -------------- | -------- | ---- | ---- | ------------- |
| sunlit         | **3080 s** | 3060 | 3160 | 3060–3160 s   |
| dark           | 2660 s   | —    | —    | —             |
| orbit          | 5739 s   |      |      |               |

The sunlit arc is strikingly uniform — 100 s of spread across every plane — which matters,
because it means the ceiling is the same everywhere in the fleet. And it gives the floor
directly:

```
migrations per orbit ≥ T / (sunlit arc) = 5739 / 3080 = 1.86
```

**A workload that always landed at the *start* of a sunlit arc would migrate 1.86 times per
orbit.** Everything measured earlier — 32.2 for naive, 9.2 for furthest-slot-in-ring — is a
multiple of that floor, and the multiple is the policy's waste.

### The freshest-sunlit rule attains the floor

Add the obvious rule the residence argument implies: hand to the satellite with the **most
sunlit arc left**, wherever it is, relays included.

| target rule                         | hand-off km | legs | ISL lattice hops | target dwell |
| ----------------------------------- | ----------- | ---- | ---------------- | ------------ |
| nearest lit, any plane              | 1279 km     | 1    | 5                | 140 s        |
| same plane, next lit slot           | 1973 km     | 1    | 1                | 260 s        |
| same plane, furthest lit slot in view | 3906 km   | 1    | 2                | 520 s        |
| **freshest sunlit, anywhere**       | **19 918 km** | **5** | 9              | **3020 s**   |
| freshest sunlit in own ring         | 21 493 km   | 6    | 11               | 2880 s       |

3020 s of dwell against a 3080 s sunlit arc: the rule gets essentially the whole arc. Followed
as a chain it lands on **1.9 migrations per workload per orbit** — the 1.86 floor, attained.

### The whole thing in one equation

Everything above follows from two facts and one constraint, and it is worth deriving rather
than tabulating, because the derivation says which knob is which.

**Fact 1 — the shadow is fixed, the satellites move through it.** The Earth's shadow points
away from the sun, which moves 1° per day, so over one 96-minute orbit the dark sector is
effectively stationary in inertial space. Let φ be a satellite's phase along its orbit. The lit
sector is a fixed range of φ, and at 550 km with a zenith panel it is **193° wide** (a
hemisphere, plus ~5.7° of `sunlit_edge` at each end).

**Fact 2 — inside one orbital plane, angle *is* time.** Every satellite in a plane flies the
same orbit, so one k slots behind reaches any given point `k·T/S` later. Distance and dwell are
not correlated quantities there, they are the same quantity in different units:

```
k slots back   =   2r·sin(kπ/S) of chord   =   k·T/S seconds of dwell
```

**The constraint — a leg cannot span more than the horizon.** Two satellites link only if the
chord clears the Earth: 5053 km at 550 km altitude, which subtends **42.8°** of orbital arc.

Now the whole problem is one sentence. A satellite carries the workload *forward* through
360° of phase per orbit; to stay in the lit sector the workload must jump *backward* by 360°
per orbit. So:

```
migrations per orbit  =  360° / (arc bought per migration)
legs      per orbit  =  360° / (arc bought per leg)          ≥ 360° / 42.8°  =  8.4
```

Two different denominators, and **that is the entire design space**. One migration may contain
several legs, so the two are independent: the first is how many *events* you slice the 360°
into, the second is how many *transfers* — and only the second is bounded from below.

### Arc bought per leg is the efficiency metric

A leg costs one full KV serialisation (160 ms for 2 GB at 100 Gbps) whether it spans 1° or
42.8°. So the figure of merit for a migration policy is **how much arc each leg buys**, against
a hard ceiling of 42.8°:

| policy                           | arc bought /migration | **arc /leg** | of the 42.8° ceiling | migrations /orbit | KV /orbit |
| -------------------------------- | --------------------- | ------------ | -------------------- | ----------------- | --------- |
| naive, nearest lit               | 150 s = 9°            | **9°**       | 21%                  | 32.2              | 64.3 GB   |
| naive, next lit slot in ring     | 260 s = 16°           | 16°          | 37%                  | 17.9              | 35.7 GB   |
| naive, furthest slot in ring     | 520 s = 33°           | 33°          | 77%                  | 9.2               | 18.4 GB   |
| predictive 90 s, furthest in ring | 610 s = 38°          | **38°**      | 89%                  | 9.3               | 18.5 GB   |
| naive, freshest sunlit           | 3020 s = 189°         | **38°**      | 89%                  | **1.9**           | 19.4 GB   |
| predictive 90 s, freshest sunlit | 3105 s = 195°         | **39°**      | 91%                  | 2.0               | 20.0 GB   |

Nothing exceeds 42.8°, as it cannot. Two rules sit at ~90% of it and one sits at 21%.

**That 21% is the whole indictment of naive-nearest, and it is not about distance.**
Naive-nearest moves the *shortest* distance of any rule here — 1254 km against the ring rule's
3906 km. It is wasteful because it pays a full leg, a full 2 GB serialisation, to buy 9° of
phase, when the same leg could have bought 42.8°. It hands the cache to the satellite directly
behind it, which is about to cross the same terminator.

### Which leaves one real choice: how to slice the 360°

Furthest-slot-in-ring and freshest-sunlit have the *same* efficiency, ~38°/leg, so they move the
same bytes — 18.4 vs 19.4 GB per workload per orbit, and 7.6 vs 7.6 in long rings, 9.5 vs 10.0
in short ones. They differ only in how the 360° is cut up:

- **9.2 migrations × 1 leg** — each cheap (0.17 s) and in view, on a ring link that never
  changes length. Nine consistency windows per orbit.
- **1.9 migrations × 5 legs** — each expensive (0.86 s) and relayed most of the way round the
  orbit. **Two** consistency windows per orbit, and 0.2% dark against 0.8%.

Same bandwidth, 5× fewer events. Which is better depends on what a migration costs you *beside*
bytes — and for a KV cache mid-decode, an event is a stall and a chance to lose state, so
fewer and larger is usually the right side of that trade. The countervailing cost is that five
relays each have to hold a 2 GB cache in flight, which this model does not charge for.

(The relation `migrations = 360° / arc` holds on the *mean* arc, while the table quotes medians.
For the skewed rules — naive-nearest especially — the median understates, which is why 360°/9°
predicts 40 migrations where 32.2 were measured. The efficient rules are tight: 360°/38° = 9.5
against 9.2 and 9.3 measured, 360°/189° = 1.9 against 1.9.)

### High inclination breaks the floor outright

The 8.4 floor comes from Fact 2 — angle is time — and Fact 2 holds *inside one plane*. Across
planes with different β it does not: another plane's lit sector sits at a different φ, so a
workload can gain sun phase without traversing arc. At 97.6° that is exactly what happens:

| policy at 97.6° / 550 km  | migrations /orbit | km     | legs | KV /orbit  | fleet ISL duty |
| ------------------------- | ----------------- | ------ | ---- | ---------- | -------------- |
| naive, nearest lit        | 73.9              | 460    | 1    | 147.9 GB   | 0.206%         |
| naive, furthest in ring   | 9.2               | 3907   | 1    | 18.4 GB    | 0.026%         |
| **naive, freshest sunlit** | **1.9**          | **3212** | **1** | **3.8 GB** | **0.005%**   |

The freshest sunlit satellite is **3212 km away and a single leg** — inside the horizon. It is
in another plane whose sun phase is offset, so the workload jumps sun phase instead of
traversing arc. That is **17× fewer migrations and 39× less bandwidth than naive-nearest at
the same inclination**, and it beats the 53° frontier by 5× on both.

Same lever as everywhere else in this file, and this is its clearest expression: **a spread of
β across planes is what lets a hand-off buy residence without buying distance.** At 53° the
planes' sun phases are too alike, so residence has to be bought by going most of the way round
the orbit — 38° of arc at a time, five legs of it. At 97.6° it is bought by changing plane, and
the 42.8° ceiling simply does not apply, because no arc is being traversed.

---

## Same plane or nearest? They are different hand-offs

"Nearest lit" and "the next sunlit satellite round my own ring" are not variants of one
choice. Inside a ring, **distance and dwell are the same quantity** — every satellite in a
plane shares a β and therefore a terminator, so the one k slots behind is both
`2r·sin(kπ/S)` away and `k·T/S` seconds later into the shadow. That makes the ring the only
place in the constellation where reaching further buys a known amount of time.

At 53° / 550 km, 10 × 22 — 22 slots of **261 s** each:

| target rule                    | hand-off km | ISL lattice hops | target dwell | target \|lat\| |
| ------------------------------ | ----------- | ---------------- | ------------ | ------------- |
| nearest lit, any plane         | 1279 km     | **5**            | 140 s        | 44°           |
| same plane, next lit slot      | 1973 km     | **1**            | 260 s        | 42°           |
| same plane, furthest in view   | 3906 km     | **2**            | **520 s**    | 38°           |
| adjacent plane only            | 1392 km     | 2                | 120 s        | 48°           |

So the same-plane hand-off is **3× further in kilometres and 5× cheaper in hops**, and it
buys nearly 4× the dwell. Distance was never the cost; hops are.

**Hopping several slots is the whole point.** Handing to the *next* lit slot buys the least
dwell there is — 261 s, then you do it again. It is a treadmill. Reaching as far back as the
horizon allows does the same hand-off once instead of k times, and how far that is, is
arithmetic:

```
slots reachable directly:  max k  where  2r·sin(kπ/S) ≤ 2√(r² − (Rₑ+80)²)
```

At 550 km with S = 22 that is **k = 2** — 3904 km, 522 s. Measured: 3906 km, 520 s. Beyond
k = 2 the ring hand-off has to relay round its own ring, which costs another 160 ms per slot
on links that already exist.

**And the ring's cost is a constant.** 1971–1974 km and 260 s per slot at *every* inclination
and both RAAN spans measured — because it depends on `S`, `h` and nothing else. Every other
rule's numbers move with inclination, β and the date; this one does not. For a hand-off budget
that is worth more than being 700 km closer.

### The horizon sets a floor on the migration rate

One direct hop can never buy more dwell than the link horizon subtends:

| altitude | link horizon | arc it spans | max dwell per hop | floor, migrations/orbit |
| -------- | ------------ | ------------ | ----------------- | ----------------------- |
| 350 km   | 3822 km      | 33.0°        | 504 s             | **10.9**                |
| 550 km   | 5053 km      | 42.8°        | 682 s             | **8.4**                 |
| 1200 km  | 7953 km      | 63.3°        | 1154 s            | **5.7**                 |

Every furthest-slot-in-ring chain measured at 550 km lands at **7.6–9.5** migrations per
workload per orbit, whatever the fleet shape. That is the floor, not the policy. **Altitude is
the only parameter that lowers it**, which is a second reason to go up alongside the eclipse
fraction.

---

## The whole fleet migrates, and bandwidth is not what stops it

Every satellite loses power once a revolution, so with a workload on each one the migration
rate is `N/T` before any churn is added. Following 25 workloads for 2 revolutions at the app's
own 5 s evaluation cadence (`MIGRATION_EVAL_SIM_SECONDS`), 53° / 550 km, 10 × 22:

| policy                        | migrations /workload /orbit | hop km | KV moved /workload /orbit | workload dark | fleet ISL duty |
| ----------------------------- | --------------------------- | ------ | ------------------------- | ------------- | -------------- |
| naive, nearest lit            | **32.2**                    | 1254   | 64.3 GB                   | 2.8%          | 0.090%         |
| naive, next lit slot in ring  | 17.9                        | 1973   | 35.7 GB                   | 1.6%          | 0.050%         |
| naive, furthest slot in ring  | **9.2**                     | 3906   | 18.4 GB                   | 0.8%          | 0.026%         |
| predictive 90 s, nearest lit  | 37.8                        | 1174   | 75.5 GB                   | **0.7%**      | 0.105%         |
| predictive 90 s, furthest slot | 9.3                        | 3905   | 18.5 GB                   | 2.7%          | 0.026%         |

**Reaching further round the ring cuts the migration count 3.5×** — 32.2 to 9.2 — while
*tripling* the distance of each hop. The same inversion as the rules table, at fleet scale.

**Bandwidth is not a constraint and is not close to one.** The busiest policy measured
occupies **0.21%** of one ISL per satellite (97.6°, naive nearest, 73.9 migrations and 148 GB
per workload per orbit); the ring policies sit at 0.02–0.05%. A 2 GB cache over a 100 Gbps
link is 160 ms, and even 32 of those per orbit is 5 s out of 5739. Bandwidth would have to
change by **~100×** — a 200 GB working set, or a 1 Gbps link — before the duty cycle reached
10%. What the naive policy costs is not bits; it is 32 opportunities per orbit for a
consistency failure, and 32 stalls whose length is the *evaluation cadence*, not the transfer.

That last point is worth separating, because it is easy to measure the wrong thing: a reactive
policy's downtime is `migrations × how often it looks`, not a property of the orbit. At a 20 s
sampling step the same chains read 3.4–4.6% dark; at the app's 5 s cadence, 0.8–2.8%. The
geometry did not change.

**Nor is there contention.** Across every configuration, 1.0–1.5 satellites of 220 enter
eclipse per 5 s step fleet-wide, and the busiest receiver is chosen by **1** of them at a time
(2 in one configuration). The no-contention assumption in `migration.ts` is not a
simplification at this scale — it is accurate. It would stop being so at a fleet where the
terminator crossings bunch, which is a different question this does not answer.

---

## Where the hand-off happens, and why waiting is not an option

Eclipse entry clusters at the orbit's **turning latitude**: |lat| p50 43° at i = 53°, 61° at
70°, 80° at 97.6°. That is also where an inclined constellation's planes converge, which is
why the nearest lit satellite gets dramatically closer as inclination rises — **506 km at
97.6°** against 1279 km at 53°, for the same fleet size.

But near is not the same as good, and two measurements say so:

- **The close high-latitude target has the *shortest* dwell.** At 97.6° the nearest lit
  satellite is 506 km away and dark again in **80 s** — the worst of any rule measured. It is
  close because the planes are bunched there, and it is about to go dark for the same reason
  the host just did. The exception is the 87.9° Delta, where the nearest target is 521 km away
  *and* lit for 3020 s — there the plane convergence and the β spread happen to line up.
- **Nobody gets a short eclipse.** The host is back in sunlight after **p50 2640 s at every
  inclination measured** (p10 2260–2580 s). There is no latitude at which a satellite dips
  into shadow briefly and comes out. So "wait for the sun instead of migrating" is never the
  cheaper option at LEO — the wait is ~44 minutes, and it is ~44 minutes at 53°, at 70°, at
  97.6°, at the equator crossing and at the pole alike.


---

## One workload or the whole constellation

Everything up to here follows workloads independently — two may pick the same target and
neither is charged for the other. That is the right model for one pipeline on a big fleet and
the wrong one for what this fork is actually about: a constellation where *everything*
computes. There the question is not where one cache goes, it is **how many caches the fleet can
keep powered at once**, with one workload per satellite and everyone contending for the same
lit hosts.

The ceiling is arithmetic, and it is tighter than "54% on average" suggests:

| pattern            | satellites powered at once | mean  | load 1.00 places |
| ------------------ | -------------------------- | ----- | ---------------- |
| 10 × 22 at 53°     | **117–120** of 220         | 54.0% | 119 workloads    |
| 5 × 44 at 53°      | 118–121                    | 54.0% | 119              |
| 20 × 11 at 53°     | **116–122**                | 54.0% | 119              |
| 10 × 22 at 97.6°   | 122–125                    | 56.1% | **123**          |

The lit population barely moves — ±1.3% in the base case — so the ceiling is effectively a hard
number rather than a distribution. Two consequences fall straight out. **Sizing is a division**:
to run W concurrent workloads you need `W / (lit fraction)` satellites, and inclination sets
that fraction (97.6° carries 123 workloads where 53° carries 119, on the same 220 satellites).
And **a fleet loaded past it cannot be rescued by scheduling** — at load 1.10 every rule lands
at 91–93%, which is just 119/131.

### There is no scheduling problem to solve

The interesting prediction was that the rules would invert under load: `fresh` is greedy and
global — every workload wants the same few satellites at the head of the lit arc — while
`ring-far` only ever asks about its own ring. A rule that wins alone could lose in a crowd.

It does not happen. Served fraction, 53° / 550 km, 10 × 22:

| rule                              | load 0.50 | load 0.90 | load 1.00 | load 1.10 |
| --------------------------------- | --------- | --------- | --------- | --------- |
| naive, nearest lit                | 99.7%     | 99.8%     | **99.8%** | 93.0%     |
| naive, furthest slot in ring      | 99.7%     | 99.8%     | 98.5%     | 92.9%     |
| naive, freshest sunlit            | 99.8%     | 99.4%     | 98.6%     | 92.3%     |
| predictive 90 s, freshest sunlit  | 100.0%    | 100.0%    | **99.5%** | 92.9%     |
| predictive 90 s, furthest in ring | 100.0%    | 100.0%    | 98.6%     | 93.2%     |

**Simple greedy local rules run the fleet to its arithmetic ceiling.** At load 1.00 — as many
workloads as there are lit satellites — the spread between the best and worst rule is 1.3
percentage points, and the best is within a fraction of a point of what perfect global
assignment could do. Contention never becomes the binding constraint: the busiest receiver is
chosen by one satellite at a time, because only 1.2 of 220 satellites cross the terminator per
5 s step and each has a whole hemisphere of lit candidates.

This is a negative result worth having, because it says where *not* to spend engineering. There
is no global assignment problem, no matching, no scheduler that buys anything. The entire
available win is in **migration cost** — the arc-per-leg metric above — not in placement.

Which makes one row the answer:

| at full load (W = 118)           | served    | migrations /orbit |
| -------------------------------- | --------- | ----------------- |
| naive, nearest lit               | 99.8%     | 32.2              |
| naive, furthest slot in ring     | 98.5%     | 9.2               |
| **predictive 90 s, freshest sunlit** | **99.5%** | **2.0**       |

0.3 points of served time against **16× fewer migration events**.

### What this does not model

One workload per satellite, migration treated as instantaneous for the purpose of occupancy,
and workloads processed in a fixed order each step — a greedy heuristic, not an optimum, which
is the point (the finding is that greedy suffices, and a better assignment has under a
percentage point to win). A satellite that hosts two workloads, a transfer that blocks its
endpoints for the 160 ms it takes, and relays that must hold a 2 GB cache in flight are all
outside it.

---

## What each Walker parameter is worth

p50 at zero demand and at 600 s, 3 revolutions, March equinox. Base 53:220/10/1@550 unless
stated.

| sweep            | pattern            | nearest neighbour | reach ≥ 0 s | reach ≥ 600 s | eclipsed |
| ---------------- | ------------------ | ----------------- | ----------- | ------------- | -------- |
| **per plane**    | S = 11             | 1056 km           | 1404 km     | 3412 km       | 33.6%    |
|                  | S = 22             | 873 km            | 1274 km     | 3467 km       | 33.6%    |
|                  | S = 44             | 535 km            | 984 km      | 3255 km       | 33.6%    |
| **planes**       | P = 5              | 1380 km           | 1400 km     | 4716 km       | 33.6%    |
|                  | P = 10             | 873 km            | 1274 km     | 3467 km       | 33.6%    |
|                  | P = 20             | 562 km            | 875 km      | 3315 km       | 33.6%    |
| **shape, N=220** | 5 × 44             | 988 km            | 989 km      | 4118 km       | 33.6%    |
|                  | 10 × 22            | 873 km            | 1274 km     | 3467 km       | 33.6%    |
|                  | 20 × 11            | 856 km            | 1008 km     | 3816 km       | 33.6%    |
| **altitude**     | h = 350 km         | 849 km            | 1242 km     | 3369 km       | 36.9%    |
|                  | h = 550 km         | 873 km            | 1274 km     | 3467 km       | 33.6%    |
|                  | h = 1200 km        | 960 km            | 1385 km     | 3559 km       | 25.8%    |
| **inclination**  | i = 53°            | 873 km            | 1274 km     | 3467 km       | 33.6%    |
|                  | i = 70°            | 838 km            | 1428 km     | **2294 km**   | 28.1%    |
|                  | i = 97.6°          | 831 km            | **506 km**  | **1657 km**   | 21.2%    |
| **phasing**      | F = 0              | 750 km            | 1104 km     | 3433 km       | 33.6%    |
|                  | F = 1              | 873 km            | 1274 km     | 3467 km       | 33.6%    |
|                  | F = 5              | 713 km            | 1200 km     | 3666 km       | 33.6%    |
| **span**         | 87.9° Delta, 360°  | 569 km            | 521 km      | **521 km**    | 21.1%    |
|                  | 87.9° Star, 180°   | 1514 km           | 428 km      | 678 km        | 23.3%    |

### Density sets the floor, and only the floor

At zero demand the reach tracks local spacing, and spacing is set by **N**, not by how N is
split. 110 → 220 → 440 satellites takes the reach from ~1400 to ~1270 to ~980 km whether the
extras go into the rings or into new planes; at fixed N = 220 the three shapes land within
300 km of each other.

It is the wrong knob to reach for: halving the reach costs **4× the fleet**, and the 600 s
column barely moves across the entire density sweep (3255–4716 km). **You cannot buy dwell with
satellites.**

### Inclination is the lever, and it is a large one

The one parameter that moves both columns, and it moves them together:

- **53°** — 1274 km now, 3467 km for 600 s of dwell.
- **70°** — 1428 km now, **2294 km** for 600 s.
- **97.6°** — **506 km** now, **1657 km** for 600 s, and 2 lattice hops rather than 4.
- **87.9° Delta** — 521 km at *every* demand out to 1800 s. The dwell curve is flat.

At high inclination the planes converge near the poles, so a satellite's near neighbours are
drawn from many planes at once — and those planes have different β, so a deeply-lit satellite
is already a neighbour. At 53° the planes run closer to parallel through the region where the
terminator is crossed, so to find a neighbour that is not about to go dark you have to leave
the neighbourhood.

Which is the same conclusion `docs/orbital-compute.md` reaches for energy, seen from the other
side, and worth one sentence: **the inclination that raises β is also the inclination that puts
a long-dwell hand-off target within one hop.** 87.9° needs 521 km and one leg for a target still
lit half an hour later; 53° needs 7979 km and two.

### Altitude buys reach, not distance

Altitude barely moves the hand-off (1242 / 1274 / 1385 km at 350 / 550 / 1200 km) but it moves
the **horizon**: 3822 / 5053 / 7953 km. At 1200 km an 1800 s target is still a single leg
(6779 km, inside the horizon); at 550 km the same demand needs a relay. Altitude is how a
demanding policy stays one hop — and it cuts the eclipse from 36.9% to 25.8%.

### Phasing and span are second-order here

F shifts the lattice and moves the reach ~15% (1104–1274 km across F = 0/1/5). The Walker Star's
180° span gives closer lit neighbours than the Delta (428 vs 521 km) and much worse dwell
(median target dark in 60 s, 27% within 60 s, against 3020 s and 0%) — the seam puts a
counter-rotating satellite alongside you briefly, which is a neighbour you cannot keep.

---

## How much of this depends on the modelling choices

**The panel model does not change the answer.** Under eclipse-only power — umbra and penumbra,
no attitude model at all — the base case reads 1141 km at zero demand against 1274 km, and 6124
against 5505 at 1200 s. The dark fraction differs a lot between the two models (46% vs 34%);
the reach does not.

**The date does, but only at the demanding end.** Over four dates the naive hand-off holds at
1044–1279 km, while the 1800 s reach runs 7683–10 297 km and the relay share swings 70–100%. A
hand-off budget quoted at zero demand is a property of the pattern; one quoted at high demand is
a property of the pattern *and the season*, and needs the range.

## Where these numbers stop

- Two-body Walker geometry propagated with SGP4: no drag, no station-keeping, no manoeuvres,
  one epoch per pattern. A pattern is a shape held still.
- κ is this repo's zenith-panel model, not a measurement — nothing in an element set describes
  attitude (`docs/starlink-energy-report.md`).
- The chord is a stand-in for an ISL. No antenna, no pointing time, no link budget, no
  contention: *reachable* means the Earth is not in the way by more than the 80 km atmospheric
  margin.
- The lattice column prices hops, not the lattice's own availability — it assumes each ring and
  same-slot link is up, which `derive-isl-topology.ts` supports for length stability but which
  says nothing about a relay that is itself dark.
- Dwell is measured against a 3-revolution window, so a target that outlives the window counts
  as satisfying any demand. At the base case none do (`never dark 0%`); where they exist the
  summary line says so.
- Sampling is 20 s for the reach tables and 5 s for the fleet-load table, so every time figure
  is quantised to that step and every distance is the one at that sample, not at the exact
  crossing. A reactive policy's downtime is a function of the step and is reported as such.
- The chains are followed independently, with no contention: two workloads may choose the same
  target and neither is charged for the other. The convergence measurement says that is
  accurate at this fleet size, not that it is accurate in general.
- The ring rule's relay pool is its own ring, which is what the drawn topology gives it. A
  fleet with more ISLs than that would do better and is not measured here.
- The freshest-sunlit rule is an oracle: it reads each candidate's *actual* remaining sunlit
  arc from the propagated timeline. A flight implementation would predict it, and the
  prediction is the easy part (illumination is a closed function of the element set and the
  date) — but the rule as measured is an upper bound, not a flown policy.
- A relayed hand-off is charged store-and-forward per leg and nothing else. Five relays that
  each hold a 2 GB cache in flight is a memory and power claim on five other satellites, and
  none of that is modelled.

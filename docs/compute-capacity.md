# Compute capacity: what a design actually delivers

How much compute a cluster can be expected to provide, how steady that expectation is, and which
knobs are worth the satellite budget. Every number is produced by `pnpm orbit-lab capacity` against
the modules the app itself runs.

`docs/orbital-compute.md` chooses an orbit. This file takes the orbit as given and asks the
operational question: **with N satellites and G GPUs each, how much work comes out per cycle, and
how much of that can be promised?**

---

## The question is a conjunction, not an average

A pipeline only produces tokens while **every stage has power at the same time**. One stage in
shadow stops the whole thing, so the fleet's mean illumination — the number every power budget is
quoted in — is not the number the service lives on. Measured, at 60 satellites in one sun-synchronous
shell:

|                               | value      |
| ----------------------------- | ---------- |
| mean illumination             | **0.805**  |
| all four stages lit at once   | **0.804**  |
| all eight stages lit at once  | **0.704**  |
| longest stall at eight stages | **28 min** |

The average is not the answer and the average is not even the shape of the answer: it stays at 0.805
while the service falls from 0.80 to 0.70, because what changes with depth is the conjunction.

## The model

Secular J₂, cylindrical shadow, sun moved sample by sample, no attitude and no panel angle:

- a satellite has power when it is outside the Earth's cylindrical shadow — the umbra is 99.9% of an
  eclipse and the penumbra is seconds;
- **no battery, no thermal model, no power policy, no attitude.** Every number here is an upper
  bound, in the same sense `docs/orbital-compute.md` states for its energy layer.

## The algorithm: pick the hosts, not the sunniest satellites

Given a pool and a stage count, `selectHosts` chooses the satellites whose **joint** power is
steadiest:

1. start from the sunniest member;
2. add the member whose outages overlap the current set's least;
3. repeat.

Greedy, and honestly so. The objective — the share of the cycle in which every chosen member has
power — is monotone _decreasing_ in the set, so this is not a submodular maximisation and the
`1 − 1/e` guarantee does not apply. What greedy does give is inspectability: every pick is the best
available at the time, and the running score is reported, so a bad pick shows as a flat step rather
than hiding inside an optimum nobody can read.

What the algorithm finds is the point:

> **Two satellites in one plane go dark together, and are never both chosen.** Plane and shell
> diversity, not illumination, is what buys availability.

Four satellites in a single plane are lit ~65% each and **~0% together** — not because the placement
is unlucky but because no four of them are ever all lit. Spend the same 24 satellites over four
planes and the same pipeline runs 100% of the time.

## Two numbers, and the gap between them is the price of migration

| number               | meaning                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| **serving fraction** | share of the cycle in which every host has power, stages staying put — what the design delivers |
| **ceiling**          | share in which _some_ set of that many satellites has power — what migration could reach        |

At 60 satellites the ceiling is 1.000 at every depth tried, even where the placement manages 0.32.
So migration is not buying "can it run at all" at this scale — it is buying the difference between a
design that stalls and one that does not, which is exactly the gap the migration ledger prices
(`docs/adr/0011-routing-around-the-earth.md`).

## Measured: 60 satellites, 8 GPUs each, one family cycle

`pnpm orbit-lab capacity <alt>:<inc> 60 8 4`

### Sun-synchronous family, 97.99° / 650 km (cycle 24.46 h)

| shells | planes | lit   | serving d=4 | serving d=8 | longest stall | GPU-hours d=8 |
| ------ | ------ | ----- | ----------- | ----------- | ------------- | ------------- |
| 1      | 2      | 0.805 | 0.804       | 0.704       | 28 min        | 1102          |
| 1      | 4      | 0.705 | 0.706       | 0.594       | 38 min        | 930           |
| 1      | 6      | 0.682 | 0.618       | 0.321       | 46 min        | 503           |
| 2      | 2      | 0.848 | **1.000**   | **1.000**   | **0**         | **1566**      |
| 3      | 2      | 0.873 | **1.000**   | **1.000**   | **0**         | **1566**      |

Four and five shells are absent: 60 satellites cannot fill that many planes that thinly and still
keep a ring link clear of the Earth.

### 53° / 550 km and 86.4° / 780 km, same budget

| reference      | 1 shell, d=8         | 2 shells, d=8 | 3 shells, d=8 |
| -------------- | -------------------- | ------------- | ------------- |
| 53° / 550 km   | 1.000                | 1.000         | 1.000         |
| 86.4° / 780 km | 0.716 (28 min stall) | 1.000         | 1.000         |

---

## What the sweep says about designing

1. **Spend the budget on shells before planes.** Going from one shell to two takes the
   sun-synchronous family from 0.704 to **1.000** and removes the stalls outright. Spending the same
   satellites on more planes inside one shell makes it _worse_ (0.805 → 0.705 → 0.682): more planes
   sample a wider range of β, including the planes whose β ≈ 0 and whose eclipses are deepest.
2. **The ring minimum is the real cap on shell count.** A plane has to hold
   `minSatellitesPerRing(h)` satellites for its ring links to clear the Earth — 10 at 353 km, 8 at
   650 km. With 60 satellites that caps a family at three shells. `k · p · perPlane ≤ N` is the
   first check, before any illumination is computed.
3. **Go deeper only where the geometry holds it.** At two shells and above, depth 8 still serves
   1.000, so GPU-hours scale with the cut (783 → 1566 for a doubling). At one shell the same cut
   buys throughput and pays for it in stalls — 18 min at depth 4, 28 min at depth 8.
4. **Node orientation is free and worth more than it looks.** At 1760 km a dawn–dusk
   sun-synchronous plane is lit **1.000** of the time and the same orbit a quarter turn away is lit
   **0.710** — same altitude, same inclination, no extra satellites.
5. **Where migration earns its keep is the single-shell design.** Its ceiling is 1.000 and its
   placement is 0.70; the hand-off is buying the 0.30, not the existence of the service.

## Open, and deliberately not done

- **The hosts are chosen for power, not for contact.** Nothing here checks that the chosen stages can
  see each other, so a serving set can be geometrically perfect and unable to exchange a packet —
  the link horizon (`./clusterRange.ts`) is the missing constraint, and adding it is the next step.
- **No battery, no panel, no thermal, no attitude.** Illumination is the ceiling a power budget is
  built under, not the budget.
- **No compute model.** FLOPs per watt, memory bandwidth, and what a 160 ms hand-off does to a decode
  loop's latency are all outside this.
- **The sun is moved but the orbit is secular.** No drag, so a long cycle is a claim about geometry
  rather than about a constellation that has been flying for a year.

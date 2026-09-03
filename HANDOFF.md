# Satvis Hand-off Document: Space Compute, Multi-Satellite Collaboration & GPU Sunlit Utilization

## 1. Project Overview & Repository Info

- **GitHub Repository**: [https://github.com/chocolatedesue/satvis.git](https://github.com/chocolatedesue/satvis.git)
- **Live deployment (GitHub Pages, this fork)**: <https://chocolatedesue.github.io/satvis/> —
  published by `.github/workflows/deploy-pages.yml` on every push to `main`. Imagery is capped at
  level 2 there (levels 3–5 need docker) and `/ot` 404s (it needs Cloudflare's `_redirects`
  rewrite); everything else is the full build.
- **Upstream deployment targets (Cloudflare Pages, credentialed host only)**:
  - `https://satvis-inertial-frame.pages.dev`
  - `https://satvis-orbit-lab.pages.dev`
- **Main Branch**: `main`

---

## 2. Core Concepts & Implemented Architecture

### A. Constellation & Orbit Construction (轨道构造)

- **Walker Delta / Star Formulation**: $i: T/P/F @ h \sim \Omega_{\text{span}}$
- **SSO Dawn-Dusk Band**: Evaluates closed-form J2 nodal regression and eclipse-free beta angles ($\beta \ge \beta_{\text{crit}}$).

### B. Stable ISL Topology & Marked Clusters (稳定拓扑)

- **Intra-plane Ring Links (Green)**: Rigid spacing within each plane ($CV \approx 0.001$).
- **Same-slot Inter-plane Links (Violet)**: Stable cross-plane topology dropping the counter-rotating seam.
- **Cross-pattern Bridge Links (Sky blue)**: Two patterns sharing an altitude _and_ an inclination are one shell in two pieces — equal mean motion and equal node rate freeze every offset between them — so each plane bridges to the plane of the other pattern nearest it in right ascension. The only wiring drawn between patterns.
- **Marked Cluster Bonds (Amber)**: Pairwise cluster tracking, styled by the shell-pair verdict (`shellLayout.ts`): solid where the geometry returns (`rigid`, `repeating`, `phase-locked`), dashed where it does not (`node-locked`, `drifting`). Occlusion behind the Earth dims opacity to 0.25 rather than disappearing.
- **Straight chords, explicitly**: link, bond, pipeline and migration polylines now pass `ArcType.NONE`. They passed `undefined`, which Cesium reads as its `GEODESIC` default — so a near-antipodal pair threw out of `EllipsoidGeodesic.setEndPoints` and stopped the whole scene rendering (intermittently, ~3 runs in 5 of `verify-migration.mjs`).

### C. Multi-Shell Stable Layouts (多轨道稳定布局)

- **The theorem first**: no two _distinct_ shells can be rigid. Freezing the phases wants an
  equal period (equal altitude); freezing the planes wants an equal node rate, which at equal
  altitude wants an equal inclination — and that is the same shell. "Stable across shells"
  therefore has to mean **periodic**, not still.
- **Node lock**: $\dot\Omega = -\tfrac{3}{2} J_2 n (R_e/a)^2 \cos i$, so a companion's inclination
  follows its altitude in closed form: $\cos i_2 = \cos i_1 (a_2/a_1)^{7/2}$. Above the
  **co-precession ceiling** $a_1|\cos i_1|^{-2/7} - R_e$ (1632 km for a 53° / 550 km shell) no
  inclination keeps up.
- **Phase return**: $\dot u = n[1 + J_2 (R_e/a)^2 (6\cos^2 i - 3/2)]$, and an altitude chosen so
  $\dot u_1 : \dot u_2$ is a small-integer ratio makes the whole configuration return every
  repeat cycle. Against 53° / 550 km: 6:5 at 1455.8 km / 22.30° (9.56 h), 8:7 at
  1201.9 km / 34.47° (12.75 h), and so on.
- **Measured, not asserted** (`scripts/derive-isl-topology.ts`, studies 7–10): the designed
  companion's seam shears **0.005°/day** against 5.21°/day for a shell picked for coverage, and
  one repeat cycle later **99.7%** of satellites find the same cross-shell partner at a median
  range change of 4 km, against **79.3%** / 398 km. The script also refines the pair against
  SGP4 (1199.2 km at 34.685°).
- **Five verdicts** (`shellLayout.ts`): `rigid`, `repeating`, `phase-locked`, `node-locked`,
  `drifting` — driving the marked-bond line style, the sky-blue cross-pattern bridge links
  (drawn only for `rigid` pairs) and the orbit lab's pairwise table.

### D. Stable Clusters & Shell Families (稳定集群与壳层家族)

- **The structure**: relative motion of two circular orbits is governed by exactly two secular
  differences — `ΔΩ̇` (planes shear) and `Δu̇` (phases slide) — and both conditions for stability
  are **equivalence relations**. So orbit space is already partitioned: finding a stable cluster
  is a quotient, not a search, and N shells cost N constraints rather than N².
- **Why not k-means**: there is no k, no centroid and no distance. Euclidean proximity in element
  space means nothing here — two shells 3 km apart drift forever, two 700 km apart can hold a
  schedule for years.
- **What does need an algorithm is tolerance**, which is not transitive, so clusters under
  tolerance _overlap_ rather than partition. Both stages stay exact: node lock is maximal windows
  over `Ω̇` sorted (an interval graph, `O(N log N)`), and the common cycle is simultaneous rational
  approximation where each candidate cycle _names_ the subset that closes it.
- **Output is a Pareto front of size against cycle**: a subset that returns sooner than the
  cluster containing it is a different offer, not a worse one (`findStableClusters`).
- **Families, written forwards** (`shellFamily`): fix the reference's revolutions per cycle, and
  every other whole number of revolutions in the band names one more node-locked shell. 53° /
  550 km holds 3 shells at 23.9 h, 7 at 47.8 h, 11 at 71.7 h — about **one more shell per six
  hours of cycle**.
- **The lever is the reference inclination**: the co-precession ceiling is 1632 km at 53° and
  **9407 km at 86.4°**, so a near-polar family holds 10 shells inside a **3°** inclination spread
  where a 53° family's eleventh has fallen to 17°. A sun-synchronous family is the strongest case
  — every member is sun-synchronous by construction, so the fleet holds a fixed local solar time
  _and_ returns its cross-shell geometry every cycle.
- Derivation, algorithm and complexity: [`docs/adr/0010-stable-clusters.md`](docs/adr/0010-stable-clusters.md);
  measurements: `scripts/derive-isl-topology.ts` studies 11–12.

### E. Space AI Compute & Multi-Satellite Collaboration (多星协同)

- Distributed inference pipeline partitioned into $N$ pipeline stages ($S_1 \to S_2 \to \dots \to S_n$), each maintaining its on-board KV-cache (e.g. 2 GB) connected over 100 Gbps ISLs.

### F. Maximizing Sunlit GPU Utilization via Predictive Pre-Handoff (日照区 GPU 利用率优化)

- **Physical Reality**: Satellite GPUs rely on solar power; entering the Earth's shadow (`umbra`, `penumbra`) or panel misalignment (`sunlit_back`) halts on-board compute.
- **Serving Conjunction Constraint**: A pipeline only produces tokens when **all stages are powered simultaneously**.
- **Naive Reactive Policy**: Migrates only _after_ power loss, causing periodic pipeline stalls and reducing sunlit GPU utilization to ~30%–45%.
- **Predictive Illumination-Aware Pre-Handoff (`predictive`)**:
  - Uses orbital illumination geometry to anticipate eclipse entry within a 90-second lookahead window (`MIGRATION_PREDICTIVE_LOOKAHEAD_SIM_SECONDS`).
  - Proactively triggers KV-cache transfer to an idle peer that has line of sight and maximum remaining sunlit duration — or, when the limb is in the way, around it through lit relays (`routesFrom`, Dijkstra over the visibility graph). **A chord through the Earth is not a link**, so it is never taken: when no lit chain reaches around, the stage is `stranded` (`docs/adr/0011-routing-around-the-earth.md`).
  - Handoff completes before shadow ingress, achieving **zero pipeline stalls** and **near 100% sunlit GPU utilization**.

### G. Store-and-Forward Relays, Incremental KV Sync, Real-Fleet Mapping & Per-Frame Occlusion (存储转发 / 增量传输 / 真实星座映射 / 逐帧遮挡)

- **Store-and-forward relay cost** (`routeTransferCost`): a relay receives the complete cache before re-sending it, so the serialisation term is paid once **per leg** (~160 ms per 2 GB at 100 Gbps) while propagation sums the legs — the relayed transfers' headline cost now includes the per-relay receive-and-emit that cut-through pricing undercounted.
- **Incremental KV sync** (`deltaSnapshot`, toggle `?miginc=true` / panel switch): the first transfer ships the full 2 GB snapshot, later ones ship only the cache's growth since the last completed transfer (~25.6 MB/s) plus what arrives while the delta serialises (closed form `p = g/(1−8r/b)`); scrubbed clocks and runaway growth fall back to the full snapshot. The ledger records actual bytes moved beside the always-full baseline; the panel shows the compression ratio.
- **Real-fleet mapping**: `?demo=real-fleet` (or the panel button) maps the pipeline onto the real Iridium NEXT catalog group (80 sats). The orbit lab's **sunlit continuity report** (`fleetContinuity`) samples up to 48 satellites over two orbits on a common grid and reports fixed-placement continuity vs the ≥k-lit service ceiling — the gap is what migration buys on real orbits.
- **Per-frame honest occlusion**: topology links evaluate line-of-sight **per frame, at the frame's own instant** inside the positions callbacks — a link the Earth stands between draws nothing that frame, at any clock multiplier (the old 400 ms wall-cadence pass let links pierce the planet for frames at a time). The pipeline chain and marked bonds keep their dim-not-hide relation semantics, with the dim verdict also computed per frame.

---

## 3. Quick Verification & Test Commands

```bash
# 0. The derivation behind the topology and the layout rules (node >= 24)
node scripts/derive-isl-topology.ts

# 1. Toolchain & Dependencies
mise trust && mise install
pnpm install

# 2. Quality Gates (Lint & Unit Tests)
pnpm lint
pnpm test
pnpm --filter satvis-worker test

# 3. Build Production Bundle
pnpm build

# 4. End-to-End Headless Browser Verification
python3 -m http.server 8791 --directory dist &
PID=$!
sleep 2
node scripts/verify-migration.mjs http://127.0.0.1:8791 /tmp/mig-verify
node scripts/verify-links.mjs http://127.0.0.1:8791 /tmp/links-verify   # ?demo=shells and ?demo=stable-shells
kill $PID

# 5. Production Deployment (Cloudflare Pages)
bash scripts/deploy-pages.sh
```

---

## 4. Key Modified Files & Module Mapping

- [`src/modules/util/shellLayout.ts`](file:///home/ccds/satvis/src/modules/util/shellLayout.ts): The multi-shell layout math — plus the cluster finder (`nodeLockedGroups`, `commonRepeatCycle`, `findStableClusters`) and the family constructor (`shellFamily`, `familyCycleHours`). The multi-shell layout math — secular rates, `coPrecessingInclinationDeg`, `coPrecessingCeilingKm`, `resonantCompanion`, `searchStableShellLayouts`, `shellPairLayout`. No runtime imports, so the derivation script can run it under node's type stripping.
- [`src/config/migration.ts`](file:///home/ccds/satvis/src/config/migration.ts): Policies (`predictive`, `naive`), 90s lookahead window, time step bounds, incremental-KV defaults and growth-rate constants (`KV_TOKENS_PER_SECOND` × `KV_MEGABYTES_PER_TOKEN`).
- [`src/modules/util/migration.ts`](file:///home/ccds/satvis/src/modules/util/migration.ts): Line-of-sight routing (`routesFrom` / `routeBetween` / `chooseRouteExcluding` — the Earth is opaque, so a hand-off takes the shortest path of real legs and strands when there is none), store-and-forward pricing (`routeTransferCost`), differential snapshot (`deltaSnapshot`), predictive decision engine (`decideStageMigration`).
- [`src/modules/MigrationLayer.ts`](file:///home/ccds/satvis/src/modules/MigrationLayer.ts): Cesium rendering layer, lookahead illumination sampler, per-leg transfer pricing, incremental sync points, ledger with full-snapshot baseline, real-time metrics status generator.
- [`src/modules/util/fleetContinuity.ts`](file:///home/ccds/satvis/src/modules/util/fleetContinuity.ts): Pure real-fleet service-continuity evaluation (fixed greedy placement vs the ≥k-lit service ceiling).
- [`src/modules/ConstellationLinksLayer.ts`](file:///home/ccds/satvis/src/modules/ConstellationLinksLayer.ts): Per-frame line-of-sight in the positions callbacks (occluded links draw nothing that frame), per-frame bond dimming.
- [`src/modules/demoScenes.ts`](file:///home/ccds/satvis/src/modules/demoScenes.ts): `applyRealFleetScene` (Iridium NEXT mapping) + `?demo=real-fleet`.
- [`src/components/OrbitLabPanel.vue`](file:///home/ccds/satvis/src/components/OrbitLabPanel.vue): Policy toggle, incremental KV toggle, KV-moved compression ratio, Sunlit GPU utilization metric display, pipeline state badges, real-fleet demo button + continuity report.
- [`src/stores/sat.ts`](file:///home/ccds/satvis/src/stores/sat.ts) & [`src/modules/sceneSync.ts`](file:///home/ccds/satvis/src/modules/sceneSync.ts): URL parameter synchronization (`migpol`, `mig`, `miginc`, `migst`, `links`, `mark`, `demo=real-fleet`).

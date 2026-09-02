# Satvis Hand-off Document: Space Compute, Multi-Satellite Collaboration & GPU Sunlit Utilization

## 1. Project Overview & Repository Info

- **GitHub Repository**: [https://github.com/chocolatedesue/satvis.git](https://github.com/chocolatedesue/satvis.git)
- **Deployment Targets (Cloudflare Pages)**:
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

### D. Space AI Compute & Multi-Satellite Collaboration (多星协同)

- Distributed inference pipeline partitioned into $N$ pipeline stages ($S_1 \to S_2 \to \dots \to S_n$), each maintaining its on-board KV-cache (e.g. 2 GB) connected over 100 Gbps ISLs.

### E. Maximizing Sunlit GPU Utilization via Predictive Pre-Handoff (日照区 GPU 利用率优化)

- **Physical Reality**: Satellite GPUs rely on solar power; entering the Earth's shadow (`umbra`, `penumbra`) or panel misalignment (`sunlit_back`) halts on-board compute.
- **Serving Conjunction Constraint**: A pipeline only produces tokens when **all stages are powered simultaneously**.
- **Naive Reactive Policy**: Migrates only _after_ power loss, causing periodic pipeline stalls and reducing sunlit GPU utilization to ~30%–45%.
- **Predictive Illumination-Aware Pre-Handoff (`predictive`)**:
  - Uses orbital illumination geometry to anticipate eclipse entry within a 90-second lookahead window (`MIGRATION_PREDICTIVE_LOOKAHEAD_SIM_SECONDS`).
  - Proactively triggers KV-cache transfer to an idle peer that has line of sight and maximum remaining sunlit duration.
  - Handoff completes before shadow ingress, achieving **zero pipeline stalls** and **near 100% sunlit GPU utilization**.

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

- [`src/modules/util/shellLayout.ts`](file:///home/ccds/satvis/src/modules/util/shellLayout.ts): The multi-shell layout math — secular rates, `coPrecessingInclinationDeg`, `coPrecessingCeilingKm`, `resonantCompanion`, `searchStableShellLayouts`, `shellPairLayout`. No runtime imports, so the derivation script can run it under node's type stripping.
- [`src/config/migration.ts`](file:///home/ccds/satvis/src/config/migration.ts): Policies (`predictive`, `naive`), 90s lookahead window, time step bounds.
- [`src/modules/util/migration.ts`](file:///home/ccds/satvis/src/modules/util/migration.ts): Target selection (`chooseTargetExcluding` — line of sight is a **preference**, with the occluded fallback recorded as `MigrationEvent.inView: false`), predictive decision engine (`decideStageMigration`).
- [`src/modules/MigrationLayer.ts`](file:///home/ccds/satvis/src/modules/MigrationLayer.ts): Cesium rendering layer, lookahead illumination sampler, real-time metrics status generator.
- [`src/components/OrbitLabPanel.vue`](file:///home/ccds/satvis/src/components/OrbitLabPanel.vue): Policy toggle, Sunlit GPU utilization metric display, pipeline state badges.
- [`src/stores/sat.ts`](file:///home/ccds/satvis/src/stores/sat.ts) & [`src/modules/sceneSync.ts`](file:///home/ccds/satvis/src/modules/sceneSync.ts): URL parameter synchronization (`migpol`, `mig`, `migst`, `links`, `mark`).

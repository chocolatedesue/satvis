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
- **Marked Cluster Bonds (Amber)**: Pairwise cluster tracking with solid bonds for same-period formations and dashed bonds for drifting cross-altitude pairs. Occlusion behind the Earth dims opacity to 0.25 rather than disappearing.

### C. Space AI Compute & Multi-Satellite Collaboration (多星协同)

- Distributed inference pipeline partitioned into $N$ pipeline stages ($S_1 \to S_2 \to \dots \to S_n$), each maintaining its on-board KV-cache (e.g. 2 GB) connected over 100 Gbps ISLs.

### D. Maximizing Sunlit GPU Utilization via Predictive Pre-Handoff (日照区 GPU 利用率优化)

- **Physical Reality**: Satellite GPUs rely on solar power; entering the Earth's shadow (`umbra`, `penumbra`) or panel misalignment (`sunlit_back`) halts on-board compute.
- **Serving Conjunction Constraint**: A pipeline only produces tokens when **all stages are powered simultaneously**.
- **Naive Reactive Policy**: Migrates only _after_ power loss, causing periodic pipeline stalls and reducing sunlit GPU utilization to ~30%–45%.
- **Predictive Illumination-Aware Pre-Handoff (`predictive`)**:
  - Uses orbital illumination geometry to anticipate eclipse entry within a 90-second lookahead window (`MIGRATION_PREDICTIVE_LOOKAHEAD_SIM_SECONDS`).
  - Proactively triggers KV-cache transfer to an idle peer with line-of-sight that has maximum remaining sunlit duration.
  - Handoff completes before shadow ingress, achieving **zero pipeline stalls** and **near 100% sunlit GPU utilization**.

---

## 3. Quick Verification & Test Commands

```bash
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
node scripts/verify-links.mjs http://127.0.0.1:8791 /tmp/links-verify
kill $PID

# 5. Production Deployment (Cloudflare Pages)
bash scripts/deploy-pages.sh
```

---

## 4. Key Modified Files & Module Mapping

- [`src/config/migration.ts`](file:///home/ccds/satvis/src/config/migration.ts): Policies (`predictive`, `naive`), 90s lookahead window, time step bounds.
- [`src/modules/util/migration.ts`](file:///home/ccds/satvis/src/modules/util/migration.ts): Target selection (`chooseTargetExcluding` with LOS guarantee), predictive decision engine (`decideStageMigration`).
- [`src/modules/MigrationLayer.ts`](file:///home/ccds/satvis/src/modules/MigrationLayer.ts): Cesium rendering layer, lookahead illumination sampler, real-time metrics status generator.
- [`src/components/OrbitLabPanel.vue`](file:///home/ccds/satvis/src/components/OrbitLabPanel.vue): Policy toggle, Sunlit GPU utilization metric display, pipeline state badges.
- [`src/stores/sat.ts`](file:///home/ccds/satvis/src/stores/sat.ts) & [`src/modules/sceneSync.ts`](file:///home/ccds/satvis/src/modules/sceneSync.ts): URL parameter synchronization (`migpol`, `mig`, `migst`, `links`, `mark`).

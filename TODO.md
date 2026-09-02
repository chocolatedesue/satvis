# Satvis Space Compute & Multi-Satellite Collaboration - TODO & Roadmap

## 1. Core Requirements Overview (核心需求全景)

用户需求核心聚焦于：**轨道构造**、**多星协同计算**、**拓扑稳定度**、**日照区 GPU 利用率最大化** 以及 **算力状态平滑活体迁移**。

- **轨道构造 (Constellation & Orbit Design)**：支持自定义 Walker Delta / Star 及太阳同步轨道（SSO）参数设计（$P$ 轨道面, $S$ 每面星数, $h$ 高度, $i$ 倾角, $F$ 相位因子），直观呈现全局与局部日照角（$\beta$）分布及年均无影区比例。
- **多星协同 (Multi-Satellite Collaboration)**：支持大模型/深度学习推理分布式管线划分（$S_1 \to S_2 \to \dots \to S_n$），各阶段分布式驻留在低轨卫星节点上，通过星间链路（ISL）实现协同推理与 KV-Cache 交互。
- **稳定性 (Topology Stability)**：
  - 同轨固定环链（Rigid Intra-plane Ring Links，极低距离波动 $CV \approx 0.001$）；
  - 异轨同槽平滑链路（Same-slot Inter-plane Links，规避跨接异动）；
  - 剔除 Walker Star 逆向缝合面（Drop Seam，消除相对高速擦肩而过的链路抖动）；
  - 同周期集群刚性几何约束（Solid Bonds），异周期自动标识漂移（Dashed Bonds）；
  - **多轨道（多壳层）稳定布局**：不同壳层之间不存在刚性静止解，稳定的可达上界是"周期性回归"——先用 J2 进动率匹配锁住轨道面，再用沿迹速率共振锁住相位回归周期。
- **提高日照区 GPU 利用率 (Maximize GPU Utilization in Sunlit Zone)**：
  - 太空计算载荷依赖太阳翼供电，仅在光照区（`sunlit_on` / `sunlit_edge`）全功率运行，地影/背光区（`umbra` / `penumbra` / `sunlit_back`）断电停摆；
  - **被动掉电迁移 (Naive Reactive)**：掉电后才被动换星，导致管线频繁停摆（日照区 GPU 实际有效利用率仅 30%~45%）；
  - **预判式协同交接 (Predictive Pre-Handoff)**：结合轨道几何与未来 90s 光照预判，在卫星进入地影前提前经 ISL 完成 KV-Cache 零中断换星交接，将**日照区 GPU 算力利用率提升至接近 100%（Zero Pipeline Stalls）**。
- **方便活体迁移 (Seamless Live Migration)**：
  - 严格遵守星间视线通视（Line-of-Sight），杜绝穿地传输；
  - 目标星优选通视良好、剩余日照寿命最长且传输时延最短的空闲节点；
  - 状态全量持久化在 URL 参数中（`?mig=true&migst=4&migpol=predictive`），支持一键分享与无状态复现。

---

## 2. Work Completed (已完成工作)

- [x] **星间拓扑与集群约束**:
  - 实现轨道内环链（Ring Links）与面间链路（Inter-plane Links）自适应生成；
  - 实现 Marked Cluster 跨星/跨壳层约束关系展示，支持地影遮挡半透明弱化（$\alpha=0.25$）。
- [x] **多星协同与预判式活体迁移引擎**:
  - 新增 `MigrationPolicy`（`predictive` vs `naive`）及 90s 日照预警窗口；
  - 实现带视线保护与日照寿命偏好的候选星优选算法 `chooseTargetExcluding`；
  - 实现 pre-eclipse proactive migration 决策与状态机更新；
  - 实现真实星间距离光速传输 + 100 Gbps 序列化真实耗时账本（Ledger）。
- [x] **前端 UI 面板与场景同步**:
  - 在 Orbit Lab 面板中提供预判式策略切换与实时指标展示（Sunlit GPU utilization、Pipeline Status、各阶段状态）；
  - 接入 URL 响应式同步（`migpol`, `mig`, `migst`, `links`, `mark`）。
- [x] **多轨道（多壳层）稳定布局求解 (Multi-Shell Stable Layout Solver)**:
  - 建立壳层间稳定性的两条闭式判据：J2 升交点进动率匹配（`cos i₂ = cos i₁ · (a₂/a₁)^(7/2)`，锁定轨道面相对排布）与沿迹角速率小整数共振（锁定相位回归周期）；
  - 证明"两个不同壳层不可能刚性静止"（冻结相位需同高度、冻结轨道面需同倾角，两者同时成立即同一壳层），因此稳定的定义应为**周期性回归**而非静止；
  - 实现伴随壳层求解器 `resonantCompanion` 与全域搜索 `searchStableShellLayouts`（含共进动高度天花板 1632 km @ 53°/550 km）；
  - SGP4 实测验证（`scripts/derive-isl-topology.ts` 研究 7–10）：设计壳层缝隙漂移 0.005°/天（对照组 5.21°/天），一个回归周期后 **99.7%** 卫星找到同一跨壳伙伴（对照组 79.3%）；
  - 五档壳层配对判定（`rigid` / `repeating` / `phase-locked` / `node-locked` / `drifting`）接入标记集群连线样式、拓扑跨壳桥接链路与 Orbit Lab 面板。
- [x] **自动化测试与质量保障**:
  - 全量单元测试（1014 个前端测试 + 36 个 Worker 测试全部通过）；
  - 静态检查（`pnpm lint` 0 error, 0 warning）；
  - 无头浏览器端到端验证脚本（`verify-links.mjs` & `verify-migration.mjs`）。

---

## 3. Next Steps / TODO (后续待办与进阶方向)

- [ ] **跨壳接触时刻表 (Precomputed Cross-Shell Contact Schedule)**:
  - 回归周期已经证明跨壳几何是周期函数，下一步是把它变成可用的时刻表：对 `repeating` 壳层对预计算一个周期内的全部跨壳可见窗口，之后按周期复用，让迁移目标选择从"每帧搜索"变成"查表"。
- [ ] **多跳星间路由寻径 (Multi-hop ISL Routing)**:
  - 当前换星为单跳直连（Single-hop LOS）；当直连目标受地球物理遮挡时，可基于 Dijkstra / Floyd 算法规划经由中继星的 2 跳/3 跳最短路由。
- [ ] **增量 KV-Cache 传输优化 (Incremental Differential Patching)**:
  - 引入增量快照算法（Differential Snapshot），仅传输推理产生的新增 Token 缓存，将换星数据量从 2 GB 压缩至数 MB。
- [ ] **大规模真实星座算力映射 (Real SATCAT Fleet Mapping)**:
  - 将协同计算模型映射到真实低轨巨型星座（如 Starlink / OneWeb / 银河航天等真实 OMM/TLE 轨道数据），评估真实天基算力网的日照服务连续度。

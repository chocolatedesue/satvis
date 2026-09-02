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
  - **稳定集群（Stable Cluster）**：两条判据都是**等价关系**，所以轨道空间本身已经被划分好了，"找集群"是求商而不是搜索——没有 k、没有质心、没有距离。需要算法的只有容差（容差破坏传递性，集群因此**相互重叠**而非划分），两阶段都是精确解：按 Ω̇ 排序取极大窗口（区间图，O(N log N)）+ 扫描候选周期（每个周期直接**点名**能闭合它的子集）。
- **提高日照区 GPU 利用率 (Maximize GPU Utilization in Sunlit Zone)**：
  - 太空计算载荷依赖太阳翼供电，仅在光照区（`sunlit_on` / `sunlit_edge`）全功率运行，地影/背光区（`umbra` / `penumbra` / `sunlit_back`）断电停摆；
  - **被动掉电迁移 (Naive Reactive)**：掉电后才被动换星，导致管线频繁停摆（日照区 GPU 实际有效利用率仅 30%~45%）；
  - **预判式协同交接 (Predictive Pre-Handoff)**：结合轨道几何与未来 90s 光照预判，在卫星进入地影前提前经 ISL 完成 KV-Cache 零中断换星交接，将**日照区 GPU 算力利用率提升至接近 100%（Zero Pipeline Stalls）**。
- **方便活体迁移 (Seamless Live Migration)**：
  - **地球不透明，穿地弦不是"长链路"而是"没有链路"**：通视是硬约束。`routesFrom` 在舰队可视图上跑 Dijkstra（按线长加权），交接走的是真实腿组成的最短路径——能直连就直连，否则绕过地平经由**有电中继**转发。跳数由几何决定而非预设：550 km 处一对卫星最多跨 42.5° 地心角，星球另一侧要五条腿，所以"单跳中继"是另一个错误答案。中继必须有电（背光星既不能收也不能发），可以同时是别的阶段的宿主；源端豁免（宿主正因即将进入地影才要交接）。没有任何有电链条绕得过去时，该阶段就是 `stranded`——这时它是事实而不是附注；
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
- [x] **地球遮挡约束与绕地多跳路由 (Earth occlusion & multi-hop routing)**:
  - 迁移目标选择由"通视优先、必要时穿地"改为**通视硬约束 + 绕地路由**：`routesFrom` 在可视图上做 Dijkstra，`chooseRouteExcluding` 保留四档优先级（前瞻安全且直连 / 直连 / 前瞻安全经中继 / 经中继）；
  - 端到端实测：原先 8149–11215 km 的穿地单弦已全部消失，改为每条腿约 4283 km 的绕地多段路径，`verify-migration.mjs` 的断言从"整跳"下沉到"每条腿" 29/29 通过；
  - 布局侧同步补上地球约束：`maxLinkRangeKm` / `linkHorizonAngleDeg` 给出闭式链路地平（550 km 对 550 km 为 42.5° / 5017 km），`StableShellLayout` 与 `StableCluster` 各自带上能达成的最长链路——一个永远回归却永远互相看不见的布局，是没有算力织物的布局（`docs/adr/0011-routing-around-the-earth.md`）。
- [x] **稳定集群与壳层家族 (Stable Clusters & Shell Families)**:
  - 从 J2 长期项完整推导：环绕轨道的相对运动只由 `ΔΩ̇`（轨道面剪切）与 `Δu̇`（相位滑移）两个差值决定，对应"刚性 / 周期回归 / 漂移"三档，与编队飞行的 `δa = 0` 无漂移条件对齐（`docs/adr/0010-stable-clusters.md`）；
  - 证明两条判据均为等价关系 ⇒ 轨道空间已被划分，N 个壳层只需 N 个约束而非 N²；k-means 之类的聚类会给一个已有正则划分的空间强加任意划分；
  - 实现 `nodeLockedGroups`（区间图极大团）、`commonRepeatCycle`（带预算的联立有理逼近）、`findStableClusters`（输出 size × cycle 的 Pareto 前沿，容差下集群重叠而非划分）；
  - 实现家族构造 `shellFamily` / `familyCycleHours`：定一个公共周期 + 每层整数圈数，两两回归由构造保证，周期不随成员数增长；
  - 定量结论（研究 11–12）：53°/550 km 下 24 h→3 层、48 h→7 层、72 h→11 层（**每多一层约 +6 h**），代价是倾角跨度扩大；**杠杆是基准倾角**——共进动天花板 53° 时 1632 km、86.4° 时 9407 km，近极家族 48 h 可容 10 层且倾角只跨 3°；太阳同步家族的每一层自动太阳同步（日照几何固定 + 跨壳几何回归）；
  - 修复 `shellPairLayout` 的周期预算：宽家族里相距 37/47 圈的两层会被默认 32 圈预算误判为 `node-locked`，现在预算可传入。
- [x] **自动化测试与质量保障**:
  - 全量单元测试（1091 个前端测试 + 107 个 Worker 测试全部通过）；
  - 静态检查（`pnpm lint` 0 error, 0 warning）；
  - 无头浏览器端到端验证脚本（`verify-links.mjs` 覆盖 `?demo=shells` 与 `?demo=stable-shells`；`verify-migration.mjs` 29/29）；
  - GitHub Pages 持续部署（`.github/workflows/deploy-pages.yml`，每次推 `main` 自动发布到 <https://chocolatedesue.github.io/satvis/>）。

---

## 3. Next Steps / TODO (后续待办与进阶方向)

- [ ] **把集群求解接到界面与真实舰队 (Wire the cluster finder to the panel and to a real fleet)**:
  - `findStableClusters` / `shellFamily` 目前只在单测与推导脚本里跑。下一步：Orbit Lab 面板加"找出这批轨道里的稳定集群"（对当前 `walker` 图案 + 已激活的真实卫星，按 (a, i) 去重后送进求解器），把 Pareto 前沿列成表；再加一个近极/太阳同步家族的 demo 场景（`?demo=sso-family`）。
  - 对真实星座跑一遍：Starlink 各壳层、OneWeb、GNSS 之间是否存在天然的 `node-locked` 组？这既是求解器的真实数据检验，也直接回答"现网里已经存在哪些稳定集群"。
- [ ] **跨壳接触时刻表 (Precomputed Cross-Shell Contact Schedule)**:
  - 回归周期已经证明跨壳几何是周期函数，下一步是把它变成可用的时刻表：对 `repeating` 壳层对预计算一个周期内的全部跨壳可见窗口，之后按周期复用，让迁移目标选择从"每帧搜索"变成"查表"。
  - 有了 `findStableClusters` 之后这一步的输入已经现成：集群自带 `cycleHours` 与每层圈数，时刻表的长度和分辨率都由它决定。
- [ ] **集群的长期有效性 (How long does a cluster actually hold?)**:
  - 当前全部结论是**长期 J2 两体**：无阻力、无三体、无 J3、无位保。集群会因为差分阻力（不同高度/面质比）而缓慢失谐，回归周期会漂。下一步是量化"多久需要一次位保脉冲才能守住这个周期"，以及给 `StableCluster` 加一个"保持成本"字段——这才是把布局从几何结论变成工程结论的那一步。
- [ ] **中继的存储转发代价 (Store-and-forward cost per relay)**:
  - 多跳路由已落地（`routesFrom`，Dijkstra + 可视图），但传输代价仍按**一次序列化 + 全程传播**计算，等价于"直通式（cut-through）中继"。若按存储转发建模，每一跳都要先收完 2 GB 再转发，100 Gbps 下每跳多花约 160 ms——这是一个真实的建模选择，会再次改变管线的头条数字，需要单独决定而不是默认假设。
  - 与之相关：中继星自身的功耗与缓存占用目前完全没有计入。
- [ ] **增量 KV-Cache 传输优化 (Incremental Differential Patching)**:
  - 引入增量快照算法（Differential Snapshot），仅传输推理产生的新增 Token 缓存，将换星数据量从 2 GB 压缩至数 MB。
- [ ] **大规模真实星座算力映射 (Real SATCAT Fleet Mapping)**:
  - 将协同计算模型映射到真实低轨巨型星座（如 Starlink / OneWeb / 银河航天等真实 OMM/TLE 轨道数据），评估真实天基算力网的日照服务连续度。

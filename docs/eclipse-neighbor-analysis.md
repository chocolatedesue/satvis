# Walker Delta 日影进入事件的邻近日照卫星分析（附 ssim vs satvis 基础建模对比）

本报告有两个交付物：

- A：ssim 与 satvis 基础建模的逐项对比，回答"差距大吗"。
- B：Walker Delta 构型下，一颗卫星**进入日影（ingress）那一刻，最近的日照卫星有多远、还能晒多久**的分布量化，含构型扫描与迁移/静止对比。

分析脚本：scripts/research/eclipse-neighbor.ts（Cesium-free，node 类型剥离可跑）。
数据：docs/eclipse-neighbor-data.csv（逐事件明细）。

用法：

    node --experimental-strip-types scripts/research/eclipse-neighbor.ts            # 默认 48h / 30s
    node --experimental-strip-types scripts/research/eclipse-neighbor.ts run 48 30
    node --experimental-strip-types scripts/research/eclipse-neighbor.ts selfcheck  # 小样本自检

---

# 交付物 A：ssim vs satvis 基础建模对比

参考快照：/tmp/ssim，tip 2ba2589。ssim 的物理在 src/ssim/physics，网络在 src/ssim/network，星座参数在 src/ssim/data/constellations/*.json，实验框架在 experiments/v4_domain_control。

| 维度                         | satvis                                                                                                                                                                                                                 | ssim                                                                                                                                                                                                                                                                                        | 差距评价                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 轨道传播                     | OMM/TLE 记成 GpRecord，createSatrec -> satellite.js SGP4（TEME），真实历元、含 J2 与阻力项；Orbit/SampledTrajectory 负责滑动采样窗与惯性/地固两套帧                                                                    | 两套：AnalyticalOrbitPropagator（默认、纯二体开普勒圆轨道，直接算 ECEF，GST 用"2000-01-01 约 100 度"的常数初值 + 固定地球自转率）；EphemOrbitPropagator（把同样根数搭成 TLE 交给 PyEphem/SGP4，返回星下点再转 ECEF，main.py 走这条）                                                        | 大。satvis 飞真实根数、绝对定位到 km 级；ssim 的快路径是圆轨道二体 + 粗糙 GST，绝对位置只有近似对齐，且两套模型并存、谁被用取决于调用点      |
| J2 项                        | 完整。orbitModel.orbitalRates 给 Ω̇、u̇ 闭式；sunSynchronous 求逆得 SSO 倾角；orbitDesign 用 β 可达性做设计；shellLayout/clusterRange 用它判壳层是否回归；orbitFacts 从 satrec 反读 Ω̇；SGP4 本身带 J2                    | 完全没有。圆轨道二体，节点不岁差，不计算太阳同步倾角，无任何长期项                                                                                                                                                                                                                          | 大。跨天/跨周的平面关系、日照周期、回归周期全部缺失；只在秒级网络快照里可忽略                                                                |
| Walker Delta 生成器          | walkerDeltaRecords：从 i:T/P/F@h（可带 ~span、+offset）生成，含 RAAN 铺开、RAAN 偏移、相位 = slot*360/S + plane*F*360/T、校验、编解码、每构型独立 satnum 段                                                            | JSON 只是元数据（n_planes、sats_per_plane、altitude_km、inclination_deg），无 F、无 RAAN offset、无 span。真正的铺开藏在 physics/gsl_trace.py 的 _setup_constellation：RAAN = plane*360/P；MA = (plane 为奇 ? 半个槽 : 0) + slot*360/S。即硬编码的 F = P/2 交错，sat_to_plane = sat_id // S | 大。ssim 只能表达一种交错、只能 Delta、且展开写死在一个函数里；本报告要扫的 F、T/P 影响它根本表达不出来                                      |
| ISL 几何                     | constellationLinks 由 derive-isl-topology.ts 派生"稳定拓扑"：面内环、同槽邻面、Walker Star 接缝丢弃、同壳跨构型桥接；migration.hasLineOfSight 做遮挡；maxLinkRangeKm = 过 80 km 大气弦                                 | LEOCraftLinkMatcher：对所有星对做欧氏距离 <= min(max_ISL_length)（80 km 切线）即建链路（双向）；GSL 按仰角 >= elev_min 且 <= max_GSL；链路带容量（ISL 50 Gbps / GSL 20 Gbps）、传播时延、可选衰减模型                                                                                       | 互补。ssim 把链路当"容量+时延+队列"的网络原语（它强的地方）；satvis 多了"哪些链路稳定"的设计层与逐帧遮挡。两者遮蔽判据实质相同（80 km 切线） |
| 光照/日影                    | 完整。illumination.ts 用 satellite.js 的圆锥影（shadowFraction，含半影）+ ν/κ/状态；energyStatistics 给 eclipse fraction、最长食、fleet 快照/序列、secondsUntilDark；orbitDesign 的 β 设计工具；迁移层做预测式食前交接 | 完全没有。没有太阳模型、没有影、没有功率/GPU 状态                                                                                                                                                                                                                                           | 极大。这是本用途（能量/光照感知算力路由）的核心，ssim 一点都没有                                                                             |
| 迁移/相位控制                | differentialDrag.ts 给沿迹漂移律 Δs = (3/4)nρΔB√(μa)t²；MigrationLayer 做 KV 迁移、预测式 pre-handoff、增量快照；migration.ts 有绕地路由与 store-and-forward 计费                                                      | 没有。无相位控制、无阻力模型（只有链路故障注入，与卫星相位无关）                                                                                                                                                                                                                            | 极大                                                                                                                                         |
| 网络/DES（ssim 主场）        | 无。没有任何离散事件仿真、队列或丢包模型；迁移层只是逐帧的几何与账本                                                                                                                                                   | 完整：core/engine.py 用 heapq 事件循环（优先级、可取消），event/packet/node/link/port、FIFO 队列（默认 100 KB）、CBR 流量、collector 统计 PDR/时延/抖动/跳数/丢包原因                                                                                                                       | satvis 被 ssim 反超的地方。若要做"路由/队列/故障下的服务可用性"，ssim 是现成底座                                                             |
| 路由/故障注入（ssim 主场）   | 只有 migration.routesFrom（可见图 Dijkstra + 绕地）用于迁移路径；无多种路由算法对比                                                                                                                                    | Dijkstra（按传播时延）、地理贪心、分层/域路由（networkx），域分段与段修复、边界摘要；fault.py 支持 link_down / weight_multiply 故障注入                                                                                                                                                     | satvis 只有单点；ssim 有成体系的对照与故障实验                                                                                               |
| 数据集/实验框架（ssim 主场） | 无实验框架；研究靠 scripts/research 下的脚本与 docs                                                                                                                                                                    | 地面站 top100、人口流量矩阵、16 个星座 JSON；experiments/v4_domain_control 有分阶段证据链（problem_presence -> ... -> boundary_summary_control）与要求的基线/指标（收敛时间、路径 stretch、瓶颈带宽、可达性、更新量）                                                                       | satvis 无；ssim 的实验组织能力更强                                                                                                           |

**一句话结论**：对"轨道能量/光照感知的算力路由"这个用途，**ssim 的基础建模不够用**——它没有光照/日影模型、没有 J2、Walker 展开写死成单一交错且无 F/RAAN offset，恰好缺的正是这个问题所依赖的三样；它的绝对传播也只是带粗糙 GST 的二体圆轨道。ssim 真正提供而 satvis 欠缺的，是离散事件网络栈（队列、多种路由、故障注入、流量与实验框架）——也就是说，ssim 适合当"网络底座"，但轨道与能量真相必须由 satvis 这类模型供给（或把两边接起来）。差距的性质是"互补但不可替代"，不是"参数精度"。

---

# 交付物 B：日影进入事件的邻近日照分析

## B.1 事件定义与指标

- **ingress 事件**：某颗卫星在相邻两个采样点上由"日照"变为"日影"。日影 = 地球遮住太阳（umbra 或 penumbra），判据用仓库自己的 isEclipsed 与 illuminationOf，与 energyStatistics.orbitEnergyProfile 的 eclipseFraction 同一套谓词；采样步长 30 s（LEO 最短食约几分钟，30 s 足以把 ingress 定位在一步内）。窗口 48 h，覆盖约 30 圈，足以采样到每个平面经过的各节点相位（53 度壳层 β 周期约 60 天，48 h 内 β 基本不变，这正是"日照占比"在构型间几乎相同的原因）。
- **进影时刻的最近日照距离**：在 ingress 那一步，取该星到全体"当前日照"卫星的 3D 弦长最小值（TEME 帧，km）。
- **该最近日照星剩余日照时长**：从该时刻起，这颗日照星还要多久进入日影。窗口内用已记录的食区间求；窗口外用最多 24 h 的前向传播续找。若 24 h 内仍不进影，则标记为"删失（censored）"，取 24 h 为下界，并把这类事件排除在 mean/median/p10 之外单列占比。
- **一跳可达**：距离 <= 该高度的最大 ISL 弦长 2*sqrt((R+h)^2 - (R+80km)^2)。用 shellLayout.maxLinkRangeKm(h,h)（WGS-72 半径 6378.135 km、80 km 裕度）：550 km -> 5016.6 km，560 km -> 5071.6 km，1200 km -> 7929.9 km。

## B.2 构型扫描

构型（id / i:T/P/F@h）：

- walker25：53:250/25/1@550（walker25 现参数，基线）
- walker25-old：53:100/25/4@550（旧 walker25，F 不同）
- starlink1：53:1584/72/17@550（Starlink 类）
- mid-incl：70:720/36/1@1200（中轨圆参考）
- near-sso：97.6:348/6/58@560（近太阳同步）
- 对照 f0：53:250/25/0@550（同 T/P/h，F=0）
- 对照 f12：53:250/25/12@550（同 T/P/h，F≈P/2，即 ssim 的交错）
- 对照 t50：53:50/25/1@550（同 P/F，T 降到 1/5）

### 各构型摘要

- **walker25（基线，25 面 x 10）**：日照占比 70.17%，ingress 6665 次，最近日照距离 mean 1054 / median 1008 / p90 1606 / max 1846 km，最近日照星剩余日照 mean 646 / median 150 / p10 60 s（32.9% 事件为 24 h 删失），一跳可达 100%。
- **walker25-old（25 面 x 4，F=4）**：日照占比 70.17%，ingress 2666 次，距离 1661/1617/2661/3079 km，剩余 941/150/60 s（40.7% 删失），一跳 100%。每面只有 4 颗时最近日照星显著更远（比基线远约 58%）。
- **starlink1（72 面 x 22）**：日照占比 70.15%，ingress 42193 次，距离 468/450/719/960 km，剩余 939/60/30 s（18.9% 删失），一跳 100%。稠密到最近日照星常在 500 km 内。
- **mid-incl（36 面 x 20 @1200）**：日照占比 78.20%，ingress 15294 次，距离 731/660/1177/1345 km，剩余 1338/90/30 s（9.5% 删失），一跳 100%。高度翻倍使日照占比明显上升（影更小），最近距离与基线同量级。
- **near-sso（6 面 x 58 @560）**：日照占比 72.54%，ingress 8707 次，距离 663/751/752/752 km，剩余 85/90/30 s（0% 删失），一跳 100%。分布最集中：最近日照星几乎总是同面环向邻居（同面 58 颗 -> 间隔 6.2 度 -> 弦长 751 km），median=p90=max=751 km。
- **f0（F=0）**：日照占比 70.17%，距离 1134/1176/1611/1726 km，比 F=1 基线远约 8%。
- **f12（F≈P/2）**：日照占比 70.17%，距离 1186/1188/1728/1837 km，比基线远约 12%。
- **t50（2/面）**：日照占比 70.18%，距离 1963/2013/2332/2358 km，是 550 km 同倾角下最稀疏的，最近日照星接近 2000 km。

### 构型横向对比表

| 构型                         | 星数 | 日照占比 | ingress 数 | 距离 mean | median | p90    | max (km) | 剩余 mean | median | p10 (s) | 删失% | 一跳% |
| ---------------------------- | ---- | -------- | ---------- | --------- | ------ | ------ | -------- | --------- | ------ | ------- | ----- | ----- |
| walker25 53:250/25/1@550     | 250  | 70.17%   | 6665       | 1054.2    | 1008.4 | 1606.4 | 1846.0   | 646       | 150    | 60      | 32.9  | 100.0 |
| walker25-old 53:100/25/4@550 | 100  | 70.17%   | 2666       | 1660.7    | 1617.0 | 2660.7 | 3078.5   | 941       | 150    | 60      | 40.7  | 100.0 |
| starlink1 53:1584/72/17@550  | 1584 | 70.15%   | 42193      | 467.5     | 449.6  | 719.2  | 959.7    | 939       | 60     | 30      | 18.9  | 100.0 |
| mid-incl 70:720/36/1@1200    | 720  | 78.20%   | 15294      | 731.2     | 660.3  | 1176.9 | 1345.3   | 1338      | 90     | 30      | 9.5   | 100.0 |
| near-sso 97.6:348/6/58@560   | 348  | 72.54%   | 8707       | 662.6     | 750.9  | 752.0  | 752.0    | 85        | 90     | 30      | 0.0   | 100.0 |
| f0 53:250/25/0@550           | 250  | 70.17%   | 6662       | 1134.1    | 1176.3 | 1610.6 | 1726.4   | 713       | 150    | 30      | 29.0  | 100.0 |
| f12 53:250/25/12@550         | 250  | 70.17%   | 6665       | 1185.8    | 1187.7 | 1727.7 | 1836.9   | 528       | 150    | 60      | 24.5  | 100.0 |
| t50 53:50/25/1@550           | 50   | 70.18%   | 1332       | 1963.4    | 2013.3 | 2332.4 | 2358.0   | 289       | 270    | 150     | 13.1  | 100.0 |

（距离 km；剩余时长 s；删失 = 最近日照星 24 h 前向内仍不进影的事件占比，不计入 mean/median/p10。550 km 一跳阈值 5016.6 km，560 km 5071.6 km，1200 km 7929.9 km。）

## B.3 迁移 vs 静止

迁移语义按仓库自身：differentialDrag 给出不同弹道系数卫星 48 h 累积的沿迹漂移，mid-transfer 舰队就是一部分星已经漂移。做法是对每隔一颗卫星的平近点角加偏移再传播，其余不变。两个变体：

- mig-drift：仓库阻力律，B=0.11 m^2/kg 且相差 100%，48 h -> 沿迹漂移 2.34 度（=3/4 n rho dB sqrt(mu a) t^2 换算）。
- mig-maneuver：每隔一颗加半个槽距 18 度，约等于 8 km 轨道差在 48 h 累积的相位（1.5*(da/a)*n*T*360 ~ 23.5 度/10 km）。

| 变体（walker25 基线） | 日照占比 | ingress 数 | 距离 mean | median | p90    | max (km) | 剩余 mean | median (s) | 删失% | 一跳% |
| --------------------- | -------- | ---------- | --------- | ------ | ------ | -------- | --------- | ---------- | ----- | ----- |
| mig-static            | 70.17%   | 6665       | 1054.2    | 1008.4 | 1606.4 | 1846.0   | 646       | 150        | 32.9  | 100.0 |
| mig-drift (+2.34 度)  | 70.17%   | 6663       | 1057.3    | 1050.5 | 1614.1 | 1846.0   | 655       | 150        | 32.7  | 100.0 |
| mig-maneuver (+18 度) | 70.17%   | 6661       | 1001.0    | 967.1  | 1598.8 | 1835.7   | 681       | 150        | 23.5  | 100.0 |

**对比结论**：相位散布没有让"进影时最近日照星"变差。物理阻力律的 2.34 度漂移把均值从 1054 抬到 1057 km（+0.3%），半槽距的迁移态反而把均值压到 1001 km（-5%）、删失率从 32.9% 降到 23.5%。原因是总星数不变时，沿迹相位只是重新分配，重新分配在局部既可能拉远也可能拉近，而对稠密壳层整体统计几乎没有影响。真正的退化来自卫星缺失/故障（星数下降），而不是相位抖动。

## B.4 结论（哪些参数把"进影时最近日照星"推远/拉近）

1. **密度主导距离，且方向明确**：最近日照星距离随每面星数（或总星数）单调下降。S=22（starlink1）467 km < S=10（walker25）1054 km < S=4（旧）1661 km < S=2（t50）1963 km。要缩短"进影到接手"的距离，加星/加密是最直接的杠杆；把 T 从 250 降到 50（t50）会让最近日照星几乎翻倍。
2. **F 有方向性但幅度小（约 10%）**：固定 T/P/h 时，F=1（1054 km）比 F=0（1134 km）和 F≈P/2=12（1186 km）都更近。即"相邻面同槽沿迹错开一个 360/T"比"面内并列"或"半槽交错"更容易在进影瞬间找到近邻。ssim 硬编码的正是 F≈P/2 这一种，恰好落在较差的一侧。
3. **高度/倾角改变的是分布形状，而非单纯的远近**：mid-incl（1200 km）日照占比升到 78.2%（影更小），但最近距离与基线同量级；near-sso（97.6 度、6 面 x 58）最近日照星几乎必然是同面环向邻居，median=p90=max=751 km——分布最集中、最可预测，但也最"固定"，缺少跨面选择。可预测性（用于调度）和距离（用于连通性）不是同一个旋钮。
4. **"有没有日照邻居"在这些设计里从不是瓶颈**：所有构型的最近日照星都在一跳 ISL 弦长内（一跳可达 100%），甚至最稀疏的 t50（最近约 1963 km）也远小于 5016 km 阈值。因此"进影星能不能一跳够到日照星"的答案是肯定的；瓶颈在接手方能撑多久。
5. **剩余日照时长从几十秒到"整天不进影"两极分化**：median 在 60-270 s，near-sso 最紧（median 90 s、p10 30 s），但 walker25 有 32.9%、walker25-old 有 40.7% 的 ingress 事件，其最近日照星在 24 h 内都不进影（位于无影平面）。也就是说，"近邻能接手"几乎总成立，但"接手后能连续服务多久"高度依赖平面相对太阳的朝向——这正是光照感知迁移要挑的。
6. **日照占比与构型参数几乎无关**：同样 53 度 / 550 km 的五个构型，eclipse 比例都是 29.8%（日照 70.2%），无论 T/P/F 如何。它由高度、倾角与 β 决定，不由布局决定。所以要改善"总日照量"要动高度/倾角，要改善"进影瞬间的邻接"才动 T/P/F。

---

# 脚本用法与数据格式

    node --experimental-strip-types scripts/research/eclipse-neighbor.ts                 # run 48 30
    node --experimental-strip-types scripts/research/eclipse-neighbor.ts run [h] [step]
    node --experimental-strip-types scripts/research/eclipse-neighbor.ts selfcheck

CSV 列：scenario, satellite, ingress_utc, distance_km, nearest_sunlit, remaining_sunlit_s, one_hop_reachable。共 110173 行（含迁移变体）。脚本在仓库根目录运行（相对写出 docs/eclipse-neighbor-data.csv）。

复用的仓库模块（均为 Cesium-free、带 .ts 扩展）：walkerDelta.walkerDeltaRecords、gp.createSatrec、illumination.illuminationOf/sunGeometry、energyStatistics.isEclipsed、shellLayout.maxLinkRangeKm、differentialDrag.differentialDragDriftM/ballisticCoefficient、orbitModel.circularSemiMajorAxisKm。

---

# 附录：自检与对齐偏差

## 自检（2 面 x 4 星，2 h，30 s）

命令：node --experimental-strip-types scripts/research/eclipse-neighbor.ts selfcheck

输出（关键行）：

    generated walker:   53:8/2/1@550
    satellites:         8
    one-hop horizon:    5016.59 km  (2*sqrt((R+h)^2-(R+80)^2))
    eclipse fraction:   17.69%
    ingress events:     5
    first ingress:
      satellite         WALKER P01-01
      time              2026-01-01T00:10:30.000Z
      nearest sunlit    WALKER P02-02  at 4542.76 km
      one-hop reachable yes
      chord, recomputed 4542.76 km  (delta 0.00e+0)
      states            WALKER P01-01=umbra, WALKER P02-02=sunlit_on
    alignment:          script 17.687% vs illuminationTimeline 17.687%  (gap 2.78e-17)

手工核对：

- 进影星 P01-01 在 2026-01-01T00:10:30Z 处于 umbra，最近日照星 P02-02 处于 sunlit_on；脚本记录的 4542.76 km 与用两颗星传播位置重算的弦长**完全一致**（delta 0）。
- 量级判断：4542.76 km < 5016.59 km 一跳阈值，因此"进影瞬间一跳够到日照星"成立且距离处于 LEO ISL 弦长的合理区间（约 0.9 倍最大弦长）。只有 8 颗星时跨面最近邻在 4500 km 量级，符合预期。
- 绝对对齐：脚本 17.687% 与仓库 illuminationTimeline 在同一网格上逐点判影得到的 17.687% 相差 2.78e-17（浮点舍入），说明本脚本与仓库的光照模型**逐点一致**，不是另写一套。
- 该事件里 P02-02 的剩余日照被标为 24 h 删失，因为 2026-01-01 时 53 度壳层的第二个平面处于无影朝向（|β| 超过 arcsin(R/(R+h))），24 h 前向内都不进影——这是物理的"无限"而非采样伪影，已在报告中单列。

## 对齐偏差（已发现并说明）

1. **影的定义**：本脚本把半影也计入日影（isEclipsed = umbra 或 penumbra），与 energyStatistics.orbitEnergyProfile.eclipseFraction 一致。若只算 umbra，ingress 会晚约 10-20 s、日照占比略高；本报告选择与仓库一致。
2. **一跳阈值的半径**：用仓库 WGS-72 半径 6378.135 km（SGP4 自身系统），而非平均半径 6371 km。按任务给定公式代入 R=6371 km 会得到约 5008 km（小 0.17%）；使用 WGS-72 是为了和 SGP4 传播、shellLayout 的 LINK_MARGIN_KM=80 km 完全一致。
3. **步长分辨率**：ingress 定义为"第一个读到日影的采样点"，真实穿越落在上一步与这一步之间，距离是穿越后 <= 30 s 的快照。LEO 约 7.6 km/s，最坏沿迹误差约 228 km，但最近日照星通常同向运动，对其距离的影响远小于该上界。
4. **删失处理**：24 h 前向内仍不进影的最近日照星标记为删失并排除在 mean/median/p10 之外，占比单列（walker25 32.9%）。这是剩余时长统计的主要不确定性；剔除删失会更保守，但也会低估"长时接手"的真实比例。
5. **窗口与 β**：48 h 覆盖约 30 圈但只覆盖 53 度壳层 β 周期（~60 天）的很小一段，因此"日照占比"反映的是 2026-01-01 前后的窗口值，不是年均值；跨季节的趋势需分别重跑。构型间的相对比较不受影响。

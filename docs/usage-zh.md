# Satvis 中文使用说明

线上地址：<https://chocolatedesue.github.io/satvis/>

本页面向「打开网页就用」的读者：先讲界面怎么用，再列 demo 场景与常用 URL 组合，最后回答几个最常见的疑问。
想要把仓库跑起来改代码，请看根目录的 [README](../README.md) 与 [HANDOFF](HANDOFF.md)。URL 参数的完整契约是
[ADR 0001](adr/0001-url-parameter-specification.md)。

## 界面导览

页面打开就是一颗可旋转缩放的地球，卫星实时绘制。左侧竖排按钮自上而下是：

| 图标   | 面板       | 作用                                                                                        |
| ------ | ---------- | ------------------------------------------------------------------------------------------- |
| 卫星   | 卫星选择   | 按编组（tag）开关卫星（Starlink、GNSS、气象、空间站等），或搜索单颗卫星                     |
| 轨道   | 卫星组件   | 每颗卫星画什么：点、标签、轨道、光照弧、轨道轨迹、地面轨迹、传感器锥、3D 模型               |
| 图钉   | 地面站     | 定位或在地图上选点添加地面站；查看即将到来的过境；把某个站设为天空视图的观察点              |
| 太阳   | 轨道实验室 | Walker 星座生成、光照着色、星簇（formation）、多壳层布局、稳定集群、迁移                    |
| 图层   | 地图       | 底图（Basemap）、叠加层（Overlays）、地形（Terrain）、地表模型（Surface）、星空（Star map） |
| 望远镜 | 视图       | 视图模式 3D / 2D / Columbus / 天空视图；相机参考系固定/惯性                                 |
| 仪表   | 渲染       | 像素比、抗锯齿（MSAA）、FPS、基准测试等性能开关                                             |
| 语言   | —          | 界面语言切换（含中文）                                                                      |

底部是**时钟控制条**：播放/暂停、播放速度阶梯、时间轴。默认是 **Live**（跟随真实现在）；
拖动时间轴会把时钟**钉**在某一刻并继续向前走，点「回到现在」恢复实时。

进入**天空视图**（`视图 → Sky`）后，画面变成从地面向上看：手机用罗盘与陀螺仪瞄准，按 `WASD` 走动、
`Q`/`E` 调整视点高度。

### 相机参考系：惯性 vs 地球固定

- **惯性系（Inertial）**：轨道面在空间中静止，地球在下方自转。这是物理上真实的情况，所有 demo 都从它开始。
- **地球固定（Earth-fixed）**：地面静止，同一条轨道看起来在扫过地球。

分辨两者的直觉：卫星入轨后不会跟着地面转。所以惯性系里「轨道不动、地球转」，地球固定系里「地面不动、轨道扫过」。

## demo 场景一览（9 个）

在网址后加 `?demo=<名字>` 会直接打开一个布置好的场景（星座已生成、组件与相机已设置、时钟速度已选好），
不需要先打开任何面板。可用名字：

| `?demo=`        | 展示什么                                                                 | 适合谁                                     |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `two-orbit`     | 两个相差 90° 的轨道面各 10 颗星，光照弧开启，惯性系，时钟 60×            | 第一次认识轨道实验室                       |
| `sso`           | 同高度、同倾角的一对太阳同步轨道：晨昏面 vs 午夜面                       | 想看懂「永昼」取决于轨道面朝向             |
| `migration`     | 在 two-orbit 场景上叠加 KV 缓存实时迁移，正好在这些卫星之间              | 想看最小的一次交接                         |
| `walker25`      | 25 个轨道面 × 每面 10 颗（共 250 颗），53°/550 km，光照着色 + 迁移       | 想要一个「任何时刻都有一颗在日影里」的星座 |
| `shells`        | 三个壳层（53°/550、70°/1200、97.6°/1200），拓扑连线 + 每个壳层一颗被标记 | 想看壳层之间的相对运动                     |
| `stable-shells` | 参考壳层、为稳定而设计的 8:7 伴星壳层，以及一个未设计的对照              | 想对比「设计出来的」和「碰巧的」多壳层布局 |
| `sso-family`    | 五个太阳同步壳层，全部在同一个 24.46 小时周期上回归，跨壳层键全部实线    | 想看「一整个家族」而不只是一对             |
| `real-fleet`    | 把迁移叠加到真实 Iridium NEXT 星座（80 颗）上                            | 想在真实编目轨道上看这套机制               |
| `cluster`       | 一个放大到全球可视尺度（约 120 km）的编队，成员两两连线                  | 想看编队（formation）而不是星座            |

时钟速度是实时视图状态、不进 URL，这正是 `?demo=` 存在的理由：普通分享链接会停在 1×，半天都不会发生一次迁移。

## 常用 URL 组合

```
# 单个 Walker 壳层，按光照着色，惯性系相机
https://chocolatedesue.github.io/satvis/?walker=53:1584/72/17@550&tags=Walker%2053:1584/72/17@550&elements=Point,Orbit&paint=illumination&camera=Inertial

# 两个壳层并排
https://chocolatedesue.github.io/satvis/?walker=53:1584/72/17@550,97.6:348/6/58@560&tags=Walker%2053:1584/72/17@550,Walker%2097.6:348/6/58@560&elements=Point

# 每个壳层标记一颗，跨壳层两两连线
https://chocolatedesue.github.io/satvis/?walker=53:40/4/1@550,70:24/4/1@1200,97.6:24/4/1@1200&tags=Walker%2053:40/4/1@550,Walker%2070:24/4/1@1200,Walker%2097.6:24/4/1@1200&mark=1-1@53:40/4/1@550,1-1@70:24/4/1@1200,1-1@97.6:24/4/1@1200&camera=Inertial

# Google Suncatcher 编队：81 颗星挤在 1 km 内，650 km 晨昏太阳同步轨道
https://chocolatedesue.github.io/satvis/?cluster=97.99:5x100@650&tags=Cluster%2097.99:5x100@650&elements=Point,Orbit&camera=Inertial

# 天空视图 + 一个地面站，并打开空间站编组
https://chocolatedesue.github.io/satvis/?scene=Sky&gs=48.1770,11.7476&tags=Stations

# demo 场景并把时钟钉在指定分钟
https://chocolatedesue.github.io/satvis/?demo=shells&time=2026-07-26T20:46Z
```

所有参数及取值见 [README 的 URL parameters 一节](../README.md#url-parameters)。

## 常见问题

### 为什么球背面的卫星看起来在反向移动？

这是惯性系下的透视效果，不是 bug。轨道面在惯性空间里是固定的，地球在它下面转；把一个轨道环从外侧看过去，
环转到地球背后时，它投影在屏幕上的运动方向就会翻转，就像你绕着时钟走一圈会看到指针改变方向。
`walker25` 里 25 个轨道面相隔 14.4° RAAN，近侧某面的卫星可能与远侧另一面的卫星在屏幕上靠得很近，
这会放大错觉。用每轨的**光照弧**（它画出的是同一条闭合椭圆）和绿色的**同面环链接**就能分辨远近两侧，
远侧那半段是同一个椭圆的背面，而不是第二条反向的轨道。

### 为什么 GitHub Pages 上底图只有 level 2？

`data/imagery/` 的 0–2 级已提交进仓库，3–5 级需要用 Docker 跑 `pnpm update-imagery` 生成。
GitHub Pages 工作流只执行 `pnpm build`，不生成这些级别，所以地球被限制在 level 2，放大后会发糊。
想要清晰版本，需要本地先生成 3–5 级，再用 Cloudflare Pages 部署（`bash scripts/deploy-pages.sh`）。

### 为什么 `/ot` 在 Pages 上是 404？

`/ot` 这个入口依赖 Cloudflare 的 `_redirects` 200 重写，而 GitHub Pages 不执行 `_redirects`。
其他入口都是构建产出的真实文件，所以只有 `/ot` 会 404。需要 OT 预设时请用 Cloudflare 部署或本地开发。

### 为什么本地或 fork 的 Pages 上，地形 / 谷歌瓦片加载失败？

仓库里自带的 Cesium ion token 被限制在 `satvis.space` 这个来源，ion 在 localhost、`deploy:preview` 来源
和第三方 iframe 里都会拒绝它。本地开发要不被限制的 token：在 `.env.development` 里设置
`VITE_CESIUM_ION_TOKEN`。没有 token 时这些资源会明确报错，而不是留给你一个空白场景。

### 为什么地址栏里的 `?demo=` 打开后就消失了？

`demo` 只在应用启动时读一次，它设置的状态会按正常路径写回 URL，所以地址栏随即变成一组自描述的参数，
`demo` 简写被丢掉。这是设计：分享出去的链接本身就能说明画面。

### 卫星数据和在线站点来自哪里？

根目录的 [README](../README.md) 与 [HANDOFF](HANDOFF.md) 有完整说明：编目数据来自 CelesTrak 的 GP 元素集
（OMM/TLE），由可选的 Cloudflare Worker 每 6 小时刷新到 KV；没有 Worker 时回退到随构建发布的静态快照。

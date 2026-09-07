// 中文。缺的 key 会回落到英文，所以这份可以滞后于新文案而不破坏界面。
//
// 术语的处理：Walker、ν、κ、β、RAAN、J₂、OMM、ISL、KV、SGP4 这些不译 ——
// `CONTEXT.md` 是术语表，代码和文档里用的就是这些名字，译了反而对不上。
// 单位、数字、轨道名、代码标识符同样原样保留。
//
// 与英文版同样的约定：含行内标记的段落用 `v-html` 渲染，安全的前提是这里的
// 每一个字符串都是开发者手写的静态内容，插值进去的只有本应用自己算出的数字。

export default {
  // 这些标签在 `config/` 里与它们所命名的值放在一起。翻译放在这里而不放在那边，
  // 是为了让 config 模块保持为与语言无关的数据——加一个点的尺寸不需要加两处，
  // 而且缺 key 会回落到下面的英文，而不是回落到裸标识符。
  labels: {
    pointSize: {
      small: "小 — 5 px",
      medium: "中 — 9 px",
      large: "大 — 14 px",
    },
    pointColorMode: {
      class: "轨道类别",
      illumination: "光照",
    },
    panelAxis: {
      zenith: "天顶（背地）",
      velocity: "速度方向",
      normal: "轨道法线",
    },
    cameraMode: {
      Fixed: "地固系 — 地面静止，轨道扫过",
      Inertial: "惯性系 — 轨道静止，地球转动",
    },
    illumination: {
      umbra: "全食 — 地球遮住整个太阳圆盘（ν = 0）。",
      penumbra: "偏食 — 地球遮住部分太阳圆盘（0 < ν < 1）。",
      sunlit_back: "受照，但帆板背对太阳（κ < 0）——有光却没电。",
      sunlit_edge: "受照，帆板几乎与太阳平行（κ ≈ 0）——掠射。",
      sunlit_on: "受照且帆板朝向太阳（κ > 0）。",
    },
  },

  common: {
    language: "语言",
    custom: "自定义",
    perPlane: "每平面 {count} 颗",
  },

  // 地球本身的框架：工具栏提示，以及它们打开的菜单的标题。图层、地表模型、星图、
  // 场景模式、相机模式的名字刻意不在这里——那些是地球自己命名的数据，不是文案。
  // 每个面板一节，改翻译的人一眼就知道这个字符串在哪个文件里。
  entity: {
    rename: "重命名",
    done: "完成",
    notify: "过境前通知我",
    skyView: "从这里看天空",
    track: "跟踪该目标",
    stopTracking: "停止跟踪",
    computing: "正在计算过境…",
    none: "近期无过境",
    start: "开始",
    end: "结束",
    links: "链接",
    unnamed: "未命名",
  },

  formation: {
    title: "编队视图",
    rotating: "旋转系",
    nonRotating: "非旋转系",
    summary: "{rings} 圈、节距 {pitch} m —— {members} 个成员在 R = {radius} km 之内，从参考卫星画出，而不是从地球上画：在那里整个编队只有几个像素宽。",
    runClock: "运行时钟即可观察。",
    rotatingNote:
      "在<strong>旋转</strong>参考系里，编队静止地待在它的椭圆内——沿航向是径向的两倍宽——并且从不出界。这就是<em>有界</em>的含义，也是这个参考系下完全看不到形变的原因。",
    nonRotatingNote:
      "在<strong>非旋转</strong>参考系里——参考卫星的坐标轴在初始时刻取一次并保持不动，卫星继续飞——椭圆随轨道转动，" +
      "于是能看到编队在变形：扁—立—扁，<strong>每圈两次</strong>。同一个运动，不同的参考系；Google 那张图画的就是这个。",
  },

  browser: {
    title: "卫星分组",
    selectGroups: "选择分组",
    search: "搜索卫星",
    loading: "正在加载卫星…",
    noMatches: "无匹配",
    clearAll: "全部清除",
    collapseGroup: "折叠分组",
    expandGroup: "展开分组",
    toggleGroup: "切换分组 {tag}",
    toggleSatellite: "切换 {name}",
    orbitClass: "{orbitClass} —— 该卫星的点被画成的颜色",
  },

  clock: {
    play: "播放",
    pause: "暂停",
    hideControls: "隐藏时钟控件",
    showControls: "显示时钟控件",
    live: "实时",
    showTimeline: "显示时间轴",
    setSpeed: "设置播放速度",
    backToRealTime: "回到真实时间",
    backToNow: "回到当前",
    playbackSpeed: "播放速度",
    timeline: "时间轴",
  },

  stations: {
    empty: "还没有——在地球上点一个，或者使用你自己的位置。",
    standsHere: "天空视图当前站在这里",
    standHere: "把天空视图站到这里",
    reorder: "拖动以调整顺序",
    name: "名称",
    latitude: "纬度",
    longitude: "经度",
    remove: "移除",
    pick: "在地球上选取",
    hint: "天空视图站在 ◉ 处，点击某个编号可移动它。",
  },

  sky: {
    flat: "把手机放平以校准正北",
    tap: "点击打开",
  },

  about: {
    title: "关于 Satvis",
    open: "关于",
    failed: "关于页面加载失败。",
    directly: "直接打开",
    loading: "加载中…",
  },

  // 基准面板是一台仪器，它的单位不译：fps、p95、ms/1k、KB/sat、MB/1k、µs/sat、
  // sats@60、r²、Δ、cpu、gpu 这些符号，任何语言的读者读法都一样。它们周围的
  // 句子则都要译。
  bench: {
    title: "BENCHMARK",
    close: "关闭",
    renderOnDemand: "按需渲染已开启 —— 这些是请求帧之间的间隔，不是帧率。",
    turnOff: "关掉",
    noComponents: "无组件",
    entities: "{count} 个实体",
    primitives: "{count} 个图元",
    sats: "{count} 颗",
    settings: "设置",
    counts: "数量",
    satComps: "卫星组件",
    clock: "时钟",
    timing: "计时",
    warmup: "预热",
    sample: "采样",
    extras: "附加项",
    groundStation: "地面站（过境预测）",
    footprint: "精确内存占用（measureUAM，约 17 秒/步）",
    run: "运行 {steps} 步",
    cancel: "取消",
    thin: "{thin}/{total} 步的采样不足 {min} 帧 —— 那些行以及由它们导出的一切都只是噪声。请保持标签页在前台。",
    head: {
      sats: "卫星",
      vis: "可见",
      clock: "时钟",
      frame: "帧",
      build: "构建",
      footprint: "占用",
      components: "组件",
      series: "序列",
      base: "基数",
      floor: "下限",
      absolute: "绝对值",
      tick: "tick",
      mainFirst: "主线程 首",
      mainAgain: "主线程 复",
      buildFirst: "构建 首",
      buildAgain: "构建 复",
      drift: "漂移",
    },
    framesSampled: "共采样 {frames} 帧",
    absoluteTitle: "同一斜率由绝对内存占用拟合而得，另有自己的 r²。与 KB/sat 一致说明两者都可信。",
    scalingCaption: "伸缩性（每 1,000 颗卫星的主线程毫秒数；下限是 GPU 加垂直同步）",
    memoryCaption: "内存（每 1,000 颗卫星的堆增长 —— 相对值；r² 成立时在强制 GC 的 2% 以内）",
    memoryWarning: "这个斜率读不出来 —— 它需要 {points}+ 个数量且 r² 达到 {r2}，否则就是垃圾回收落在了序列中间，其偏移并非各行共有。请扫描更多数量，或重跑。",
    propagationCaption: "传播（同一场景在 ×1 下的时钟滴答毫秒数）",
    repeatsCaption: "结束后重跑的第一步（漂移）",
    log: "打印日志",
    idle: "空闲",
    copied: "已复制 {format}",
    clipboardRefused: "剪贴板被拒绝 —— 已改为打印到日志",
    copyCsv: "复制 CSV",
    copyJson: "复制 JSON",
    copyTable: "复制表格",
    drew: " → 实际绘制 {count}",
  },

  shell: {
    menu: {
      cat: "卫星选择",
      sat: "卫星组件",
      gs: "地面站",
      lab: "轨道实验室：Walker 星座与光照",
      map: "地图",
      view: "视角",
      ios: "移动端",
      render: "渲染",
    },
    github: "GitHub",
    toggleUI: "显示 / 隐藏界面",
    map: {
      basemap: "底图",
      overlays: "叠加层",
      terrain: "地形",
      surface: "地表模型",
      starMap: "星图",
    },
    view: {
      title: "视角",
      camera: "相机",
      aiming: "指向",
      compass: "使用罗盘",
      walkNote: "WASD 移动观察者，Q 和 E 改变高度。",
    },
    mobile: {
      vr: "VR",
      play: "播放",
      faster: "加快播放速度",
      slower: "减慢播放速度",
      reload: "重新加载",
    },
    render: {
      measurement: "测量",
      fps: "帧率",
      benchmark: "基准测试",
      requestRender: "按需渲染",
      effects: "场景效果",
      fog: "雾",
      lighting: "光照",
      hdr: "HDR",
      atmosphere: "大气",
      pixelRatio: "像素比",
      native: "{ratio}x（原生）",
      ratio: "{ratio}x",
      msaa: "抗锯齿 (MSAA)",
      off: "关",
      msaaRate: "{rate}x",
    },
  },

  orbitLab: {
    group: {
      constellation: "Walker 星座",
      demos: "演示场景",
      marked: "标记集群",
      shells: "多壳层布局",
      migration: "多星协同与实时迁移",
      fleet: "真实星座映射",
      patterns: "已生成的星座",
      sunSync: "太阳同步",
      illumination: "光照",
      log: "迁移日志",
    },

    pattern: {
      intro:
        "Walker 记法 <code>i: T/P/F</code> —— T 颗星分在 P 个平面，每个平面相对上一个沿航向偏移 F·360°/T。生成为固定历元下的圆轨道元素集，" +
        "所以这是该图案的几何，而不是对任何真实星座的预报。",
    },

    camera: {
      inertial: "惯性系",
      fixed: "地固系",
      note:
        "轨道平面在<em>惯性</em>空间里是固定的，而不是在旋转的地球上——一旦入轨，它并不跟着地面转。所以在<strong>惯性系</strong>里轨道静止不动、地球在下面转，" +
        "这才是真实发生的；在<strong>地固系</strong>里地面静止不动，同一条静止的轨道看起来就在扫过天空。下面每个演示都在惯性系里打开。",
    },

    demos: {
      twoOrbit: "两圈演示",
      twoOrbitNote:
        "一键：两个轨道平面相距 90°，各带十颗卫星，轨道线按光照着色，点的颜色跟着变并放大，时钟设在 {multiplier}×，所以一圈大约 {seconds} 秒。" +
        "看一个点从受照弧段跨进阴影弧段、颜色随之改变。",
      penumbraNote: "半影无论哪边都是一条细缝：在约 96 分钟的一圈里，卫星穿过它只要 10–20 秒，所以在弧线上它是每个阴影边界处的一道蓝色短刻线，而不是一条带。",
      arcNote: "<code>Illumination arc</code> 组件在「卫星组件」菜单里。它打开时会顶替普通的 <code>Orbit</code>——两者是同一个椭圆，都画会 z-fighting。",
      sunSync: "永照太阳同步演示",
      sunSyncNote:
        "两条太阳同步轨道，高度都是 <strong>{altitude} km</strong>，唯一的区别是轨道平面朝向太阳的方式：晨昏那条永不进入地球阴影，正午—子夜那条每圈有三分之一被食。" +
        "同样的高度、同样的倾角——只差平面转了四分之一圈。",
      shells: "堆叠壳层演示",
      shellsNote:
        "同时三个 Walker 壳层——<strong>53° / 550 km</strong> 的 4 平面各 10 颗、<strong>70° / 1200 km</strong> 的 4 平面各 6 颗，以及 <strong>97.6° / 1200 km</strong>，" +
        "时钟设在 {multiplier}×。每个壳层自身是刚性的，动的是壳层与壳层之间。550 km 那层会套两个更高壳层的圈（在这个速度下约每 76 秒一个相对整圈），" +
        "而两个同周期的高壳层则保持沿航向锁定，转而在升交点上彼此漂开，交叉缝每个模拟日爬过几度 RAAN。",
    },

    links: {
      label: "显示星座链路",
      note:
        '把每个生成的 Walker 卫星接进推导脚本选定的拓扑：每个平面内的<span style="color: #34d399">绿色环形链路</span>长度稳定在千分之一以内，' +
        '<span style="color: #a78bfa">紫色的平面间链路</span>随平面交叉而伸缩，穿过地球背后的链路是隐藏而不是画穿过去，Walker Star 的接缝永远不接——' +
        "它的两端以两倍轨道角速度互相掠过。",
    },

    marked: {
      markColumn: "标记一列",
      markCrossShell: "每个壳层标记一颗",
      clear: "清除标记",
      note:
        '标记一小队卫星以便作为一个整体观察：每个成员带一个<span style="color: #fbbf24">琥珀色光环</span>和它的槽位标签，每一对之间用琥珀色连线——' +
        "跨平面、跨壳层，不管规则，因为标记集群的意义就在于用眼睛检验稳定性。<strong>标记一列</strong>取第一个图案里每个平面的同一槽位：" +
        "连线保持几何不变（沿航向偏移是精确的），整个集群像一把刚性梯子一样飞。<strong>每个壳层标记一颗</strong>则横跨各壳层：周期相同的能保持，" +
        "周期不同的会剪切，连线会显示哪个是哪个。线型就是稳定性判定，直接从画面上读出来：<strong>实线</strong>连接周期相同的成员，两者永不分离，" +
        "距离包络每圈重复；<strong>虚线</strong>连接周期不同的成员，它会走完会合周期而从不落定。连线被地球遮挡时是变暗而不是消失，" +
        "让集群关系在整个轨道上始终可见。",
    },

    shells: {
      demo: "稳定布局演示",
      note:
        "一个壳层、一个为配合它而设计出来的伴生壳层，以及一个不是的。两个不同的壳层之间不存在刚性——冻结相位要求周期相等，冻结平面要求节点率相等，" +
        "两者同时满足就是同一个壳层——所以布局改为针对<em>回归</em>来设计：先让节点率匹配，使各平面保持相对排布，再挑一个高度使沿航向速率落在小整数比上，" +
        "整个构型就在一个周期上回来。推导实测 99.7% 的卫星在一个周期后找到同一个跨壳伙伴，而单纯按覆盖挑的壳层只有 79%。",
      facts: {
        nodeRate: "本壳层节点率",
        nodeRateTitle: "J₂ 隆起使这条轨道的升交点转得多快——只有两者一致时，两个壳层才能保持固定的平面排布",
        ceiling: "共旋上限",
        ceilingTitle: "高于这个高度，没有任何倾角的进动能慢到跟得上本壳层的节点率",
        companion: "最佳伴生",
        companionTitle: "构型回来得最快的那个伴生：它的节点率匹配，且沿航向速率与参考成整数比",
        cycle: "重复周期",
        cycleTitle: "两个壳层回到同一相对构型所需的时间——每个距离和每个接触窗口都在它上面重复",
      },
      add: "添加这个伴生壳层",
      addNote:
        "由表单里的高度和倾角解出：伴生的倾角来自 <code>cos i₂ = cos i₁ · (a₂/a₁)^(7/2)</code>，也就是节点率一致的那个点；高度则来自闭合周期的共振。" +
        "这是长期 J₂ 的结果，传播器实际需要再多约十分之一度——<code>scripts/derive-isl-topology.ts</code> 会拿 SGP4 对两者做精化并打印修正量。" +
        "锁定的代价是倾角：伴生越高，它就得飞得越平。",
      verdictsNote:
        "每一对已生成的星座图案，按它对另一条所做的事来分：<strong>rigid</strong>（一个壳层拆成两半——所有偏移都冻结，也是唯一会被拓扑用" +
        '<span style="color: #38bdf8">蓝色</span>跨接的情况）、<strong>repeating</strong>（平面锁定，相位在周期上回来）、<strong>phase-locked</strong>' +
        "（周期相同，平面在剪切）、<strong>node-locked</strong>（平面保持，相位永远在滑动）和 <strong>drifting</strong>（两者都不是）。",
    },

    migration: {
      kvDemo: "KV 缓存与 GPU 迁移演示",
      fleetDemo: "25×4 星座迁移演示",
      overlay: "显示迁移叠加层",
      stages: "流水线级数",
      incremental: "增量 KV 同步（差分快照）",
      policyPredictive: "预测式（食前交接 · 高 GPU 利用率）",
      policyNaive: "反应式（失效后 · 朴素基线）",
      incrementalNote:
        "打开<strong>增量 KV 同步</strong>后，某一级第一次传输会发送完整的 {gigabytes} GB 快照，之后的每一次只发送自上次完成传输以来缓存的增长量——" +
        "按每模拟秒追加约 25.6 MB KV 计算（64 decode token/s，每个 token 0.4 MB），这就把 GB 量级的迁移变成几百 MB 甚至更少。" +
        "下面的「KV 已迁移」一行显示的是相对「每次都全量」基线的比值。中继按存储转发计费：每一跳都要把整个载荷重新序列化，所以中继的代价是每段一次序列化。",
      pipelineNote:
        "一条推理流水线被切成 {stageCount} 级，各级在自己的卫星上持有自己的 {gigabytes} GB KV 缓存——一级一颗星，通过稳定的星间链路（ISL）连接。" +
        "太空 GPU 靠太阳能，而太阳能只在受照区可用。",
      policyNote:
        "<strong>预测模式</strong>（推荐）利用轨道几何和光照前瞻，在进入阴影<em>之前</em>就主动跨 ISL 交接负载，消除流水线停顿，使 GPU 计算利用率接近 100%。" +
        "<strong>反应模式</strong>等到断电才动作，于是每次穿越阴影都会造成流水线停顿。",
      servingNote: "流水线只有在<strong>每一</strong>级同时有电时才产出 token。下面的<strong>受照 GPU 利用率</strong>测的就是这段「全部有电」的服务时间在模拟时间里的占比。",
      opaqueNote:
        "<strong>地球是不透明的。</strong>一条穿过地球的弦不是「一条很长的链路」——在任何功率预算下它都不是链路。所以交接只能交给宿主看得见的那颗星；" +
        "而当宿主已经把帆板转开、在近侧临边之外看不到任何有电的邻居时，缓存会<strong>绕过</strong>临边，经由一个能同时看到两端的有电中继，" +
        "画成一条在中继处折弯的两段线。传输按整条线计费，所以经中继的一跳比它两端之间的直线看起来更贵。只有当没有任何有电的星能绕过地球看到对侧时，" +
        "某一级才会变成 <code>stranded</code>——那此时它就是事实，而不是一句报告。",
      facts: {
        status: "流水线状态",
        policy: "策略",
        utilization: "受照 GPU 利用率",
        migrations: "迁移次数",
        kvMoved: "KV 已迁移",
        isl: "在途 ISL",
      },
      status: {
        serving: "服务中（计算中）",
        stalled: "停顿",
        stagesPowered: "{powered}/{total} 级有电",
      },
      policy: {
        predictive: "预测式交接",
        reactive: "反应式基线",
      },
      stage: {
        nearEclipse: " · 接近食区",
        sunlit: " · 受照",
        dark: " · 失电",
        stranded: " · 搁置",
      },
      linkTime: "{kilometres} km",
      transferMs: "{ms} ms",
      kvMovedValue: "{payload}，链路时间 {ms} ms",
      lessThanFull: "· 比全量少 {delta}×",
      logNote: "最新在前，时间为做出迁移决策时的模拟时刻。",
    },

    fleet: {
      demo: "Iridium NEXT 星座映射演示",
      note:
        "把同一条计算流水线映射到<strong>真实的编目星座</strong>上——Iridium NEXT，来自实时 CelesTrak OMM 星历的 {count} 颗卫星，" +
        "是唯一真正承载交叉链路业务的大型星座。布局、迁移策略、中继路由和账本都不变；变的是轨道是真的，拓扑也就成了迁移层视线路由算出来的那个样子。" +
        "链接 <code>?demo=real-fleet</code> 打开同一个场景。",
      evaluate: "评估受照连续性（{count} 颗真实卫星）",
      evaluating: "评估中…",
      facts: {
        meanSunlit: "平均受照占比",
        meanSunlitTitle: "在采样窗口内每颗卫星能为其计算供电的时长占比，按整个星座平均",
        best: "最优单星",
        bestTitle: "星座中光照最好的那颗星——单级流水线固定布局的成绩",
        fixedPlacement: "{stages} 级固定布局",
        fixedPlacementTitle: "把流水线一次性固定映射到星座中光照最好的几颗星上：只有所有宿主同时受照时才服务",
        ceiling: "{stages} 级服务上限",
        ceilingTitle: "在同一时刻至少有这么多颗星受照的时间占比——这是预测式交接、中继路由和增量同步所能达到的天花板",
      },
      sampleNote: "在 {satellites} 颗卫星上按 {step} 秒步长采样两个轨道周期。两行之间的差距就是实时迁移在真实星座上买到的东西：固定布局追不上太阳，会迁移的流水线能。",
    },

    form: {
      preset: "预设",
      total: "总数 (T)",
      planes: "平面数 (P)",
      phasing: "相位因子 (F)",
      inclination: "倾角 °",
      altitude: "高度 km",
      raanSpan: "RAAN 跨度 °",
      derived: "每平面 {perPlane} 颗 · 周期 {period} 分钟 · {meanMotion} 圈/天",
      walkerStar: " · Walker Star（平面跨 180°）",
      showOnly: "只显示",
      regenerate: "重新生成",
      add: "添加",
      hideAll: "全部隐藏",
      showOnlyTitle: "只绘制 {wire}",
      addTitle: "把 {wire} 与其余的一起绘制",
    },

    patterns: {
      stopDrawing: "停止绘制这个星座",
      draw: "绘制这个星座",
      load: "把这些数值载入表单",
      forget: "移除这个星座",
      edit: "编辑",
      note: "它们全都写在 url 里，所以这个链接就是整个场景：",
    },

    sunSync: {
      note:
        "由上面的高度反解 J₂ 节点进动 Ω̇ = −(3/2)·J₂·n·(Rₑ/a)²·cos i 得到，令其等于太阳自身的 0.9856°/天。长期二体结果，与元素集所用的 WGS-72 同一系统——" +
        "与公开的倾角值相差约 0.1° 以内。",
      facts: {
        reachable: "可达 β 与需求 β",
        reachableTitle: "在一年中最好的时刻、这个倾角的任何平面所能达到的最大 |β|，对照此处阴影所要求的 β",
        neverEclipsed: "永不受食的平面",
        neverEclipsedTitle: "这个壳层里完全避开地球阴影的平面占比，按全年平均。只取决于高度和倾角。",
        exchange: "1° 倾角相当于",
        exchangeTitle: "在这个高度上，多少公里的高度能买到与一度倾角相同的 β 余量",
        nodeDrift: "本轨道节点漂移",
        nodeDriftTitle: "J₂ 隆起使这条轨道的升交点转得多快——所谓「固定」只是近似成立的那个速率",
        inclination: "太阳同步倾角",
        inclinationTitle: "使这个高度成为太阳同步的倾角",
        worstBeta: "最差 β（晨昏）",
        worstBetaTitle: "一年中最糟糕的时刻，晨昏平面的太阳高出轨道平面的角度",
        requiredBeta: "保持受照所需 β",
        requiredBetaTitle: "轨道要避开地球阴影所必须超过的 |β|：arcsin(Rₑ/(Rₑ+h))，再加一度给半影",
        always: "是否永照？",
      },
      verdictYes: "是",
      verdictNo: "否",
      knobsNote:
        "三个旋钮，从强到弱：<strong>升交点相对太阳的位置</strong>在倾角所允许的范围内挑 β，而且不要钱——<strong>倾角</strong>把那个上限一对一抬高——" +
        "<strong>高度</strong>只降低阴影的要求，约 0.02°/km。完整扫描见 <code>docs/starlink-energy-report.md</code>。",
      notExactNote: "固定，但不精确：地球的 J₂ 隆起每天把每条轨道的升交点转过几度——国际空间站是 −5°/天，而太阳同步轨道恰好是 +0.9856°/天，这正是这类轨道的全部诀窍。",
      bandNote:
        "永照的晨昏轨道只存在于 <strong>{band}</strong> 之间——是一个带，不是一个下限：阴影随高度缩小，但太阳同步要求越来越陡的逆行倾角，" +
        "这反过来压住了 β。超过这个带，第二个效应就赢了。所有已飞过的晨昏任务（Sentinel-1 在 693 km，TerraSAR-X 在 514 km）都在它之下，" +
        "只在一年中的部分时间不受食。",
      use: "把这个倾角用于表单",
    },

    illumination: {
      note: "ν 是太阳圆盘未被地球遮住的比例（satellite.js 的锥形阴影模型）。κ 是太阳与假定帆板法线之间的带符号余弦——这是一个模型，不是事实：任何元素集都不携带姿态信息。",
      pointSize: "点的大小",
      panelNormal: "帆板法线",
      census: "屏幕上 {total} 颗卫星",
      withoutPower: " · {share} 没有可用电力",
      switchNote: "把着色切到「光照」即可把这些状态涂到地球上。",
      clickNote: "点一颗卫星即可读出它的 ν/κ 和下一圈。",
      stripTitle: "从现在起 {orbits} 圈（{minutes} 分钟），每 {step} 秒一个采样",
      stripNote: "接下来 {orbits} 圈（{minutes} 分钟）：本影 {umbra} · 半影 {penumbra} · 背向 {back} · 合计无电 {dark}",
    },

    presetNotes: [
      "两个平面相距 90°，各带十颗卫星——少到能跟住一颗，又多到每种状态都同时存在。",
      "三个平面各两颗——少到能一次盯着一颗卫星看。",
      "极地 Walker Star：6 个平面跨 180°，经典的交叉链路设计。",
      "53° / 550 km 壳层作为一个 Walker 图案——72 个平面各 22 颗。",
      "53.2° / 540 km 壳层——36 个平面各 20 颗。",
      "97.6° 近极壳层——6 个平面各 58 颗，按倾角即为太阳同步。",
      "1200 km 的极地 Walker Star——18 个平面各 36 颗。",
    ],
  },
};

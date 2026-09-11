// English — the source of truth for every key. Other locales may lag; a missing
// key falls back here rather than rendering itself.
//
// Prose notes carry inline markup (`<code>`, `<strong>`, a coloured `<span>` for a
// link colour). They are rendered with `v-html`, which is safe here and only here
// because every string in this file is developer-authored and static — nothing a
// user types, and no orbit name or preset label, is ever interpolated into one.
// The only interpolations are numbers this app computed.

export default {
  // Labels that live in `config/` next to the value they name. Translated here
  // rather than there so the config modules stay language-free data — a reader
  // who adds a point size should not have to add it twice, and a missing key
  // falls back to the English below rather than to the raw identifier.
  labels: {
    pointSize: {
      small: "Small — 5 px",
      medium: "Medium — 9 px",
      large: "Large — 14 px",
    },
    pointColorMode: {
      class: "Orbit class",
      illumination: "Illumination",
    },
    panelAxis: {
      zenith: "Zenith (anti-nadir)",
      velocity: "Velocity",
      normal: "Orbit normal",
    },
    cameraMode: {
      Fixed: "Earth-fixed — ground still, orbit sweeps",
      Inertial: "Inertial — orbit still, Earth turns",
    },
    illumination: {
      umbra: "Full eclipse — the Earth covers the whole solar disc (ν = 0).",
      penumbra: "Partial eclipse — the Earth covers part of the solar disc (0 < ν < 1).",
      sunlit_back: "Sunlit, but the panel faces away from the sun (κ < 0) — no power despite the light.",
      sunlit_edge: "Sunlit, panel nearly edge-on to the sun (κ ≈ 0) — grazing incidence.",
      sunlit_on: "Sunlit with the panel facing the sun (κ > 0).",
    },
  },

  common: {
    language: "Language",
    custom: "Custom",
    perPlane: "{count} per plane",
  },

  // The globe's own chrome: toolbar tooltips, and the headings of the menus they
  // open. Layer, surface-model, star-map, scene-mode and camera-mode names are
  // deliberately absent — those are data the globe itself names, not prose.
  // One section per panel, so a reader fixing a translation knows which file the
  // string appears in.
  entity: {
    rename: "Rename",
    done: "Done",
    notify: "Notify for upcoming passes",
    skyView: "View the sky from here",
    track: "Track entity",
    stopTracking: "Stop tracking",
    computing: "Computing passes…",
    none: "No upcoming passes",
    start: "Start",
    end: "End",
    links: "Links",
    unnamed: "unnamed",
  },

  formation: {
    title: "Formation view",
    rotating: "Rotating",
    nonRotating: "Non-rotating",
    summary:
      "{rings} rings at {pitch} m — {members} members inside R = {radius}, drawn from the reference satellite rather than from the globe, where the whole formation is a few " +
      "pixels wide.",
    spacing: "nearest neighbours {nearest}–{furthest}",
    turned: "ellipse turned {degrees}°",
    runClock: "Run the clock to watch it.",
    rotatingNote:
      "In the <strong>rotating</strong> frame the formation sits still inside its ellipse — twice as wide along-track as it is tall — and never leaves it. That is " +
      "what <em>bounded</em> means, and it is why this frame shows no deformation at all.",
    nonRotatingNote:
      "In the <strong>non-rotating</strong> frame — the reference's axes captured once and held while it flies on — the ellipse turns with the orbit and the " +
      "formation is seen to deform, flat to upright to flat, <strong>twice per orbit</strong>. Same motion, different frame; this is the one Google's figure is drawn in.",
  },

  browser: {
    title: "Satellite groups",
    selectGroups: "Select groups",
    search: "Search satellites",
    loading: "Loading satellites…",
    noMatches: "No matches",
    clearAll: "Clear all",
    collapseGroup: "Collapse group",
    expandGroup: "Expand group",
    toggleGroup: "Toggle group {tag}",
    toggleSatellite: "Toggle {name}",
    orbitClass: "{orbitClass} — the colour this satellite's point is drawn in",
  },

  clock: {
    play: "Play",
    pause: "Pause",
    hideControls: "Hide clock controls",
    showControls: "Show clock controls",
    live: "Live",
    showTimeline: "Show timeline",
    setSpeed: "Set playback speed",
    backToRealTime: "Back to real time",
    backToNow: "Back to now",
    playbackSpeed: "Playback speed",
    timeline: "Timeline",
  },

  stations: {
    empty: "None yet — pick one on the globe, or use your own position.",
    standsHere: "The sky view stands here",
    standHere: "Stand the sky view here",
    reorder: "Drag to reorder",
    name: "Name",
    latitude: "Latitude",
    longitude: "Longitude",
    remove: "Remove",
    pick: "Pick on globe",
    hint: "The sky view stands at ◉, click a number to move it.",
  },

  sky: {
    flat: "Hold the phone flat to set north",
    tap: "Tap to open",
  },

  about: {
    title: "About Satvis",
    open: "About",
    failed: "The about page could not be loaded.",
    directly: "Open it directly",
    loading: "Loading…",
  },

  // The benchmark panel is an instrument, and its units are not translated:
  // fps, p95, ms/1k, KB/sat, MB/1k, µs/sat, sats@60, r², Δ, cpu and gpu are
  // symbols a reader of one language reads the same way. Everything a sentence
  // says around them is.
  bench: {
    title: "BENCHMARK",
    close: "Close",
    renderOnDemand: "render-on-demand is on — these are gaps between requested frames, not a frame rate.",
    turnOff: "turn off",
    noComponents: "no components",
    entities: "{count} entities",
    primitives: "{count} primitives",
    sats: "{count} sats",
    settings: "settings",
    counts: "counts",
    satComps: "sat comps",
    clock: "clock",
    timing: "timing",
    warmup: "warmup",
    sample: "sample",
    extras: "extras",
    groundStation: "ground station (pass prediction)",
    footprint: "accurate memory footprint (measureUAM, ~17 s/step)",
    run: "Run {steps} steps",
    cancel: "Cancel",
    thin: "{thin}/{total} steps sampled under {min} frames — those rows, and everything derived from them, are noise. Keep the tab in front.",
    head: {
      sats: "sats",
      vis: "vis",
      clock: "clock",
      frame: "frame",
      build: "build",
      footprint: "footprint",
      components: "components",
      series: "series",
      base: "base",
      floor: "floor",
      absolute: "absolute",
      tick: "tick",
      mainFirst: "main 1st",
      mainAgain: "main again",
      buildFirst: "build 1st",
      buildAgain: "build again",
      drift: "drift",
    },
    framesSampled: "{frames} frames sampled",
    absoluteTitle: "The same slope from absolute footprints, with its own r². Agreement with KB/sat means both can be trusted.",
    scalingCaption: "scaling (main-thread ms per 1,000 satellites; floor is GPU plus vsync)",
    memoryCaption: "memory (heap growth per 1,000 satellites — relative; within 2% of a forced GC when r² holds)",
    memoryWarning:
      "that slope cannot be read — it needs {points}+ counts and r² {r2}, or a garbage collection landed inside the series and its offset is not common to the rows. Sweep more " +
      "counts, or re-run.",
    propagationCaption: "propagation (clock-tick ms over the same scene at ×1)",
    repeatsCaption: "first step re-run at the end (drift)",
    log: "Log",
    idle: "idle",
    copied: "copied {format}",
    clipboardRefused: "clipboard refused — logged instead",
    copyCsv: "Copy CSV",
    copyJson: "Copy JSON",
    copyTable: "Copy table",
    drew: " → drew {count}",
  },

  shell: {
    menu: {
      cat: "Satellite selection",
      sat: "Satellite components",
      gs: "Ground station",
      lab: "Orbit lab: Walker constellations and illumination",
      map: "Map",
      view: "View",
      ios: "Mobile",
      render: "Render",
    },
    github: "GitHub",
    toggleUI: "Toggle UI",
    map: {
      basemap: "Basemap",
      overlays: "Overlays",
      terrain: "Terrain",
      surface: "Surface",
      starMap: "Star map",
    },
    view: {
      title: "View",
      camera: "Camera",
      aiming: "Aiming",
      compass: "Use compass",
      walkNote: "WASD walks the observer, Q and E change height.",
    },
    mobile: {
      vr: "VR",
      play: "Play",
      faster: "Increase play speed",
      slower: "Decrease play speed",
      reload: "Reload",
    },
    render: {
      measurement: "Measurement",
      fps: "FPS",
      benchmark: "Benchmark",
      requestRender: "RequestRender",
      effects: "Scene effects",
      fog: "Fog",
      lighting: "Lighting",
      hdr: "HDR",
      atmosphere: "Atmosphere",
      pixelRatio: "Pixel ratio",
      native: "{ratio}x (Native)",
      ratio: "{ratio}x",
      msaa: "Antialiasing (MSAA)",
      off: "Off",
      msaaRate: "{rate}x",
    },
  },

  orbitLab: {
    group: {
      constellation: "Walker constellation",
      demos: "Scenes",
      marked: "Marked cluster",
      formation: "Formation cluster",
      formationCloseUp: "Formation close-up",
      shells: "Multi-shell layout",
      clusters: "Stable clusters",
      migration: "Multi-satellite compute & live migration",
      fleet: "Real fleet mapping",
      patterns: "Generated patterns",
      clusterPatterns: "Generated formations",
      sunSync: "Sun-synchronous",
      illumination: "Illumination",
      log: "Migration log",
    },

    pattern: {
      intro:
        "Walker notation <code>i: T/P/F</code> — T satellites in P planes, each plane offset along-track from the last by F·360°/T. Generated as circular element sets at a " +
        "fixed epoch, so this is the pattern's geometry, not a forecast of any real constellation.",
    },

    camera: {
      inertial: "Inertial",
      fixed: "Earth-fixed",
      note:
        "An orbit plane is fixed in <em>inertial</em> space, not in the rotating Earth's — once launched it does not follow the ground round. So in " +
        "<strong>Inertial</strong> the orbit holds still and the Earth turns underneath it, which is what actually happens; in <strong>Earth-fixed</strong> the ground " +
        "holds still and the same stationary orbit appears to sweep past. Every demo below opens in the inertial frame.",
    },

    demos: {
      twoOrbit: "Two-orbit demo",
      twoOrbitNote:
        "One click: two orbital planes 90° apart with ten satellites each, orbit lines coloured by illumination, points coloured to match and enlarged, and the clock at " +
        "{multiplier}× so an orbit takes about {seconds} s. Watch a point cross from the sunlit arc into the eclipsed one and change colour as it goes.",
      penumbraNote:
        "Penumbra is a sliver either way: a satellite crosses it in 10–20 s of a ~96 minute orbit, so on the arc it is a short blue tick at each eclipse boundary rather " +
        "than a band.",
      arcNote:
        "The <code>Illumination arc</code> component is in the satellite-components menu. It stands in for the plain <code>Orbit</code> while it is on — the two are the " +
        "same ellipse, so drawing both would z-fight.",
      sunSync: "Always-sunlit SSO demo",
      sunSyncNote:
        "Two sun-synchronous orbits at <strong>{altitude} km</strong>, differing only in how their plane faces the sun: the dawn–dusk one never enters the Earth's shadow, " +
        "the noon–midnight one is eclipsed for a third of every orbit. Same altitude, same inclination — a quarter turn of the plane apart.",
      shells: "Stacked-shells demo",
      shellsNote:
        "Three Walker shells at once — 4 planes of 10 at <strong>53° / 550 km</strong>, 4 planes of 6 at <strong>70° / 1200 km</strong> and <strong>97.6° / 1200 km</strong> " +
        "— with the clock at {multiplier}×. Each shell is rigid inside itself; what moves is shell against shell. The 550 km one laps the two higher shells (a full relative " +
        "revolution about every 76 s at this speed), while the two same-period high shells hold their along-track lock and drift apart in node instead, their crossing seam " +
        "creeping a couple of degrees of RAAN per simulated day.",
    },

    links: {
      label: "Show constellation links",
      note:
        'Wires every generated Walker satellite into the topology the derivation script picked: <span style="color: #34d399">green ring links</span> inside each plane hold ' +
        'their length to within a part in a thousand, <span style="color: #a78bfa">violet inter-plane links</span> breathe as their planes cross, a link that passes behind ' +
        "the Earth is hidden rather than drawn through it, and the Walker Star seam is never wired — its endpoints sweep past each other at twice orbital rate.",
    },

    // The generator for the formation cluster: four numbers, the same shape as
    // the Walker form above, because a formation is four numbers too.
    cluster: {
      empty: "No formation yet — build one in the group below, or open ?demo=cluster.",
      preset: "Preset",
      rings: "Rings",
      pitch: "Radial pitch m",
      inclination: "Inclination °",
      altitude: "Altitude km",
      derived: "{members} members inside R = {radius} km",
      pitchNote:
        "The along-track pitch is <strong>twice</strong> the radial one, and is not settable — that is the epicycle's own axis ratio, and only that choice makes the extent a circle " +
        "in lattice index rather than an ellipse.",
      showOnly: "Show only",
      regenerate: "Regenerate",
      add: "Add",
      hideAll: "Hide all",
      showOnlyTitle: "Draw only {wire}",
      addTitle: "Draw {wire} beside the others",
    },

    clusterPresetNotes: [
      "Google's free-flying compute cluster: 81 satellites inside 1 km, dawn-dusk SSO, 100 m x 200 m lattice.",
      "Two rings — the smallest lattice that still fills its bounding ellipse, and few enough to watch one member.",
      "Three rings at 200 m pitch: R = 1.2 km, the same shape spread far enough apart to read at a distance.",
      "The same three-ring formation blown up to R = 120 km — the same dynamics, at a size a globe can draw. Members are tens of kilometres apart, so the bonds between them are lines rather than a pixel.",
    ],

    marked: {
      markColumn: "Mark one column",
      markCrossShell: "Mark one per shell",
      clear: "Clear marks",
      note:
        'Marks a small fleet to watch as a unit: each member carries an <span style="color: #fbbf24">amber halo</span> and its slot label, and every pair is bonded in amber ' +
        "— across planes and across shells, rules aside, because the point of a marked cluster is to test stability by eye. <strong>Mark one column</strong> picks the same " +
        "slot in every plane of the first pattern: the bonds hold their geometry (along-track offsets are exact) and the cluster flies as a rigid ladder. " +
        "<strong>Mark one per shell</strong> spans the shells: same period holds, different period shears, and the bonds show which is which. The line style is the stability " +
        "verdict, read straight off the picture: a <strong>solid</strong> bond joins members sharing a period, so the pair never parts and its distance envelope repeats " +
        "every orbit; a <strong>dashed</strong> bond joins members whose periods differ, and it drifts through its synodic cycle without ever settling. Bonds dim when " +
        "occluded by the Earth rather than disappearing, keeping the cluster relation visible throughout the orbit.",
    },

    shells: {
      demo: "Stable-layout demo",
      note:
        "One shell, the companion designed to hold against it, and a companion that was not. Nothing rigid exists between two different shells — freezing the phases wants an " +
        "equal period, freezing the planes wants an equal node rate, and both at once is the same shell — so a layout is designed for <em>return</em> instead: match the " +
        "node rates so the planes hold their arrangement, then pick the altitude so the along-track rates land in a small-integer ratio and the whole configuration comes " +
        "back on a cycle. The derivation measures 99.7% of satellites finding the same cross-shell partner one cycle later, against 79% for a shell picked for its coverage alone.",
      facts: {
        nodeRate: "Node rate, this shell",
        nodeRateTitle: "How fast the J₂ bulge turns this orbit's node — two shells hold a fixed plane arrangement only where these agree",
        ceiling: "Co-precession ceiling",
        ceilingTitle: "Above this altitude no inclination precesses slowly enough to keep up with this shell's node",
        companion: "Best companion",
        companionTitle: "The companion whose configuration returns soonest: its node rate matches, and its along-track rate is in a whole-number ratio",
        cycle: "Repeat cycle",
        cycleTitle: "How long the two shells take to return to the same relative configuration — every range and every contact window repeats on it",
      },
      add: "Add the companion shell",
      addNote:
        "Solved from the form's altitude and inclination: the companion's inclination comes from <code>cos i₂ = cos i₁ · (a₂/a₁)^(7/2)</code>, which is where the node " +
        "rates agree, and its altitude from the resonance that closes the cycle. Secular J₂, so the propagator wants about a tenth of a degree more — " +
        "<code>scripts/research/derive-isl-topology.ts</code> refines both against SGP4 and prints the correction. The price of the lock is inclination: the higher the companion, " +
        "the shallower it has to fly.",
      verdictsNote:
        "Every pair of generated patterns, by what it does to the other: <strong>rigid</strong> (one shell in two pieces — every offset frozen, and the only case the " +
        'topology bridges across in <span style="color: #38bdf8">blue</span>), <strong>repeating</strong> (planes locked, phases returning on a cycle), ' +
        "<strong>phase-locked</strong> (equal period, planes shearing), <strong>node-locked</strong> (planes held, phases sliding forever) and <strong>drifting</strong> " +
        "(neither).",
    },

    // The third thing the app calls a cluster: the partition orbit space already
    // has. The other two (a marked cluster across shells, a formation inside one)
    // are drawn; this one was only ever printed to a terminal.
    clusters: {
      note:
        "Two orbits hold their relative arrangement only where their node rates agree and their phases return — and both conditions are <strong>equivalence relations</strong>, so orbit space is " +
        "already partitioned: a cluster is a <em>quotient</em>, not a search. There is no k, no centroid and no distance, which is why k-means has nothing to offer here — two shells 3 km apart drift " +
        "forever, two 700 km apart can hold a schedule for years. What does need an algorithm is tolerance, which is not transitive, so clusters under tolerance <strong>overlap</strong> rather than " +
        "partition, and the honest answer is a Pareto front of size against cycle rather than one grouping.",
      demo: "Sun-synchronous family demo",
      demoNote:
        "{shells} shells at once, every pair of them returning on one cycle, and every one of them sun-synchronous because each is node-locked to a sun-synchronous reference. The reference turns " +
        "{revolutions} times per cycle; each other shell takes a whole number of turns beside it. <code>?demo=sso-family</code>",
      foundTitle: "Stable clusters among the generated patterns ({count})",
      mark: "Mark",
      marked: "Marked",
      markTitle: "Bond one satellite per member, so the cluster is watchable rather than only tabulated",
      watch: "Watch",
      watchTitle: 'Bond the cluster and run one whole cycle in {seconds} s — the only rate at which "returns every X h" is checkable',
      range: "closest {closest} / horizon {horizon}",
      contact: "in contact {share} of the cycle",
      foundNote:
        "Every maximal set of shells that closes one cycle, best first — a subset that returns <em>sooner</em> than the cluster containing it is a different offer rather than a worse one, which is why " +
        "one shell can appear in several rows. <strong>slip</strong> is the worst along-track error a member carries into the next cycle; the <strong>link budget</strong> is the shortest range any pair " +
        "in the cluster could ever close, so a cluster whose members never come inside it returns to a geometry no fabric can be built on.",
      none: "No cluster closes a cycle among the {count} distinct orbits on screen — add a second shell, or press beside the companion the multi-shell group solves for.",
      family: "Family from this shell",
      revolutions: "Reference revolutions per cycle",
      familyDerived: "{shells} shells, {sats} satellites, returning every {cycle}",
      facts: {
        altitude: "Altitudes",
        altitudeTitle: "The band a family may spread across — above the drag, below the inner belt",
        inclination: "Inclinations",
        inclinationTitle:
          "The price of the lock: node-locking a higher shell to this one costs inclination, because cos i₂ = cos i₁ · (a₂/a₁)^(7/2) — which is also why a near-polar reference holds a far wider family",
        revolutions: "Turns per cycle",
        revolutionsTitle: "Whole revolutions each shell makes in one family cycle — the integers inside the band are the family",
      },
      flyFamily: "Fly this family",
      familyNote:
        "Writes a partition forwards instead of searching for one: fix how many turns the reference makes per cycle, and every other whole number of turns inside the band names one more node-locked " +
        "shell. Every pair returns <em>by construction</em>, so a shell added costs nothing in stability — what it costs is inclination spread and cycle length, and both are in the rows above.",
    },

    migration: {
      kvDemo: "KV-cache & GPU migration demo",
      fleetDemo: "25x10 fleet migration demo",
      overlay: "Show migration overlay",
      stages: "Pipeline stages",
      incremental: "Incremental KV sync (differential snapshot)",
      policyPredictive: "Predictive (Pre-eclipse handoff · High GPU uptime)",
      policyNaive: "Reactive (Post-failure · Naive baseline)",
      incrementalNote:
        "With <strong>incremental KV sync</strong> on, a stage's first transfer ships the full {gigabytes} GB snapshot and every later one ships only the cache's growth " +
        "since its last completed transfer — at ~25.6 MB of appended KV per simulated second (64 decode tokens/s at 0.4 MB/token), that turns a gigabyte-scale migration " +
        "into hundreds of megabytes or less. The KV-moved row below shows the ratio against the always-full baseline. Relays are charged store-and-forward: every hop " +
        "re-serialises the whole payload, so relaying costs a serialisation per leg.",
      pipelineNote:
        "An inference pipeline is cut into {stageCount} stages, each holding its own {gigabytes} GB KV cache on its own satellite — one stage per satellite, connected via " +
        "stable inter-satellite links (ISLs). Space GPUs rely on solar power, which is only available in the sunlit zone.",
      policyNote:
        "<strong>Predictive mode</strong> (Recommended) uses orbit geometry and illumination lookahead to proactively hand off workloads across ISLs <em>before</em> " +
        "entering eclipse, eliminating pipeline stalls and keeping GPU compute utilization near 100%. <strong>Reactive mode</strong> waits until power is lost, causing " +
        "pipeline stalls at every shadow crossing.",
      servingNote:
        "The pipeline only produces tokens while <strong>every</strong> stage has power simultaneously. <strong>Sunlit GPU utilization</strong> below measures that " +
        "all-powered serving uptime over simulated time.",
      opaqueNote:
        "<strong>The Earth is opaque.</strong> A chord that passes through the planet is not a long link — it is not a link, at any power budget. So a hand-off takes a " +
        "satellite the host can see; and when a host has turned its panel away and sees no powered neighbour over the near limb, the cache goes <strong>around</strong> the " +
        "limb through a lit relay that can see both ends, drawn as a two-segment line bending at the relay. The transfer is charged for the whole wire, so a relayed hop " +
        "costs more than the straight line between its ends would suggest. Only when nothing lit can see around the Earth is a stage <code>stranded</code>, which is then the " +
        "truth rather than a report.",
      facts: {
        status: "Pipeline Status",
        policy: "Policy",
        utilization: "Sunlit GPU utilization",
        migrations: "Migrations",
        kvMoved: "KV moved",
        isl: "ISL in flight",
      },
      status: {
        serving: "serving (computing)",
        stalled: "stalled",
        stagesPowered: "{powered}/{total} stages powered",
      },
      policy: {
        predictive: "Predictive handoff",
        reactive: "Reactive baseline",
      },
      stage: {
        nearEclipse: " · near eclipse",
        sunlit: " · sunlit",
        dark: " · dark",
        stranded: " · stranded",
      },
      linkTime: "{kilometres} km",
      transferMs: "{ms} ms",
      kvMovedValue: "{payload} in {ms} ms of link time",
      lessThanFull: "· {delta}× less than full",
      logNote: "Newest first, at the simulated time the migration was decided.",
    },

    fleet: {
      demo: "Iridium NEXT fleet mapping demo",
      note:
        "Maps the same compute pipeline onto a <strong>real catalogued constellation</strong> — Iridium NEXT, {count} satellites from the live CelesTrak-derived OMM catalog, " +
        "the one large fleet that actually flies cross-linked traffic. Placement, migration policy, relay routing and the ledger all work unchanged; what changes is that the " +
        "orbits are real, and the topology is whatever the migration layer's line-of-sight routes make of it. The link <code>?demo=real-fleet</code> opens the same scene.",
      evaluate: "Evaluate sunlit continuity ({count} real satellites)",
      evaluating: "Evaluating…",
      facts: {
        meanSunlit: "Mean sunlit fraction",
        meanSunlitTitle: "How much of the sampled window each satellite can power its compute, averaged over the fleet",
        best: "Best single satellite",
        bestTitle: "The best-lit satellite in the fleet — a one-stage pipeline's fixed-placement figure",
        fixedPlacement: "{stages}-stage fixed placement",
        fixedPlacementTitle: "A fixed mapping of the pipeline onto the fleet's best-lit satellites, chosen once: serves only when all its hosts are lit together",
        ceiling: "{stages}-stage service ceiling",
        ceilingTitle:
          "Share of instants with at least this many satellites lit at once, whatever they are — the ceiling predictive handoff, relay routing and incremental sync can reach",
      },
      sampleNote:
        "Sampled over two orbits at {step} s steps across {satellites} satellites. The gap between the two rows is what live migration buys on the real fleet: the fixed " +
        "placement cannot chase the sun, the migrated pipeline can.",
    },

    form: {
      preset: "Preset",
      total: "Total (T)",
      planes: "Planes (P)",
      phasing: "Phasing (F)",
      inclination: "Inclination °",
      altitude: "Altitude km",
      raanSpan: "RAAN span °",
      derived: "{perPlane} per plane · {period} min period · {meanMotion} rev/day",
      walkerStar: " · Walker Star (planes over 180°)",
      showOnly: "Show only",
      regenerate: "Regenerate",
      add: "Add",
      hideAll: "Hide all",
      showOnlyTitle: "Draw only {wire}",
      addTitle: "Draw {wire} beside the others",
    },

    patterns: {
      stopDrawing: "Stop drawing this pattern",
      draw: "Draw this pattern",
      load: "Load these numbers into the form",
      forget: "Forget this pattern",
      edit: "edit",
      note: "All of them travel in the url, so this link is the whole scene:",
    },

    sunSync: {
      note:
        "Computed from the altitude above, by inverting the J₂ nodal precession Ω̇ = −(3/2)·J₂·n·(Rₑ/a)²·cos i for the sun's own 0.9856°/day. Secular two-body, in the same " +
        "WGS-72 system the element sets use — within about 0.1° of the published inclinations.",
      facts: {
        reachable: "Reachable β vs demanded",
        reachableTitle: "The best |β| any plane at this inclination can reach, at the best moment of the year, against what the shadow demands here",
        neverEclipsed: "Planes never eclipsed",
        neverEclipsedTitle: "Share of this shell's planes that clear the Earth's shadow entirely, averaged over a year. Depends on altitude and inclination alone.",
        exchange: "1° inclination is worth",
        exchangeTitle: "How much altitude buys the same β margin as one degree of inclination, at this altitude",
        nodeDrift: "Node drift, this orbit",
        nodeDriftTitle: "How fast the J₂ bulge turns this orbit's node — the rate by which “fixed” is only nearly true",
        inclination: "Sun-sync inclination",
        inclinationTitle: "The inclination that makes this altitude sun-synchronous",
        worstBeta: "Worst β (dawn–dusk)",
        worstBetaTitle: "Sun elevation above the orbit plane at the worst moment of the year, for a dawn–dusk plane",
        requiredBeta: "β needed to stay lit",
        requiredBetaTitle: "What |β| must clear for the orbit to miss the Earth's shadow: arcsin(Rₑ/(Rₑ+h)), plus a degree for the penumbra",
        always: "Always sunlit?",
      },
      verdictYes: "yes",
      verdictNo: "no",
      knobsNote:
        "The three knobs, weakest last: <strong>where the node sits relative to the sun</strong> picks β within the range the inclination allows, and is free — " +
        "<strong>inclination</strong> raises that ceiling one-for-one — <strong>altitude</strong> only lowers what the shadow demands, at about 0.02°/km. Full sweep in " +
        "<code>docs/starlink-energy-report.md</code>.",
      notExactNote:
        "Fixed, but not exactly: the Earth's J₂ bulge turns every orbit's node a few degrees a day — −5°/day for the ISS, and precisely +0.9856°/day for a sun-synchronous " +
        "orbit, which is the whole trick those orbits are built on.",
      bandNote:
        "Always-sunlit dawn–dusk orbits exist only between <strong>{band}</strong> — a band, not a floor: the shadow shrinks with altitude, but sun-synchrony demands an " +
        "ever steeper retrograde inclination, which caps β. Above the band the second effect wins. Every flown dawn–dusk mission (Sentinel-1 at 693 km, TerraSAR-X at 514 km) " +
        "sits below it and is eclipse-free for part of the year only.",
      use: "Use this inclination for the form",
    },

    illumination: {
      note:
        "ν is the fraction of the solar disc left uncovered by the Earth (satellite.js's conical shadow model). κ is the signed cosine between the sun and an assumed solar " +
        "panel normal — a model, not a fact: no element set carries attitude.",
      pointSize: "Point size",
      panelNormal: "Panel normal",
      census: "{total} satellites on screen",
      withoutPower: " · {share} without usable power",
      switchNote: "Switch the colouring to Illumination to paint these states onto the globe.",
      clickNote: "Click a satellite to read its ν/κ and its next orbit.",
      stripTitle: "{orbits} orbits from now ({minutes} min), {step} s per sample",
      stripNote: "Next {orbits} orbits ({minutes} min): {umbra} umbra · {penumbra} penumbra · {back} back-facing · {dark} dark in total",
    },

    presetNotes: [
      "Two planes 90° apart with ten satellites each — few enough to follow one, enough that every state is occupied at once.",
      "Three planes of two — small enough to watch one satellite at a time.",
      "Polar Walker Star: 6 planes over 180°, the classic cross-linked design.",
      "The 53° / 550 km shell as a Walker pattern — 72 planes of 22.",
      "The 53.2° / 540 km shell — 36 planes of 20.",
      "The 97.6° near-polar shell — 6 planes of 58, sun-synchronous by inclination.",
      "Polar Walker Star at 1200 km — 18 planes of 36.",
    ],
  },
};

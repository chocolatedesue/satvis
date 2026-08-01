# Benchmarking framework

Three questions about satvis's performance, answered repeatably:

> How does the frame cost scale with the number of satellites, what does each
> satellite component cost on top of the ones already being drawn, and what does
> running the clock faster — that is, propagating more often — cost?

It replaces the console-paste script that used to be `src/modules/benchmark.ts`,
which measured average and worst frame time and printed one line per step. The
same idea, with the parts that made its numbers hard to trust fixed: percentiles
instead of an average and a max, warmup frames discarded, a build torn down
before the next one is timed, the first step re-run at the end to catch drift,
and what was _actually drawn_ recorded next to what was asked for.

## Run it

**Debug menu → Benchmark**, or `?bench=true` in the url. They are the same switch:
it is `cesium.showBenchmark`, url-synced like every other debug toggle, so a
benchmarking session is a shareable link.

Opening the panel is what loads the framework, and that is also what puts
`window.bench` there for console use.

**Measure a production build, not `pnpm dev`** — a dev build is unminified and runs
Vue in development mode, so its numbers are pessimistic by an unknown factor:

```bash
pnpm build && pnpm preview
```

Then the panel, or the console:

```js
bench.quick(); // 3 counts × 7 isolated sets — checks the harness
bench.run(); // 5 counts × 7 isolated sets: each component's own cost
bench.cumulative(); // 5 counts × 8 growing sets: cost on top of what is already drawn
bench.clock(); // 5 counts × 4 clock rates: the propagation axis
bench.run({ satelliteCounts: [0, 500, 5000], componentSets: [["Point", "Orbit"]] });
bench.run({ clockMultipliers: [1, 100] }); // any sweep can take the clock axis
bench.run({ groundStation: { lat: 48.18, lon: 11.75 } }); // switches pass prediction on
bench.run({ repeatFirstStep: false }); // skip the closing drift check
bench.watch(); // log a live line every 2 s; returns a stop function
bench.cancel();
bench.log();
bench.csv();
bench.json();
bench.text();
```

Every sweep closes by re-running its first step, so the step count is one more
than the axes multiply out to. A step costs `warmupMs + sampleMs` (2 s + 4 s by
default) plus its build, which is what keeps the default counts down to five.

Keep the tab in the foreground. A background tab presents no frames at all and
every row becomes a lie — see the first caveat below.

## What it measures

A step is one point in a three-axis sweep: **satellite count × component set ×
clock rate**. The clock axis is one value (×1) unless asked for, so it costs
nothing when the question is only about drawing.

| Column           | Meaning                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `fps`, `frameMs` | Between presented frames. What the user feels; flattens against vsync at 60/120 fps |
| `cpuMs`          | `preUpdate` → `postRender`. The work done, which keeps moving after fps has capped  |
| `p95`, `worst`   | Percentiles, not just a max — one 400 ms frame should not define a row              |
| `frames`         | The sample size. A handful means the row is noise; read this one first              |
| `jankPct`        | Share of frames slower than 33 ms                                                   |
| `clock`          | The clock rate the step ran at, as a multiple of real time                          |
| `buildMs`        | The synchronous cost of building the scene: instantiation plus component creation   |
| `clearMs`        | Tearing the previous scene down                                                     |
| `visible`        | Satellites actually drawn, which is **not** always the count requested              |
| `drawn`          | Components actually drawn, when they differ from the ones requested                 |
| `heapMb`         | Chrome only, bucketed to 5 MB. A trend, not a figure                                |

And derived, across steps:

- **scaling** — a least-squares fit of `cpuMs` against the satellites drawn, per
  _series_ (component set **and** clock rate, so a fit is never averaged across
  clocks): ms per 1,000 satellites, the fixed cost at zero, r² (well under 1.0
  means the cost is _not_ linear in the count), and where 60 fps runs out.
- **marginal cost** — each set differenced against the largest set measured under
  the same conditions that is a strict subset of it. In a cumulative sweep that is
  the cost of the component just added; in an isolated sweep it is that component's
  cost over a bare point. One function serves both.
- **propagation** — each clock rate differenced against ×1 for the same satellites
  and components. Only present when the clock was actually swept, because an empty
  table would read as "propagation is free" rather than "nobody asked".
- **drift** — the first step, re-run as the last step, against its original.
  A sweep is minutes long and the app it measures does not hold still: shader
  caches fill, the JIT settles, the heap grows. This is the only figure in the run
  that can tell a rising line that is the scene from a rising line that is the
  clock, so a small `cpuDriftPct` is what licenses reading the other tables at
  all — over 10% and both the panel and `logRun` say so. The repeat step is
  excluded from every other table: it is a second sample of a scene already in the
  set, and averaging it in would weight one point twice and hide the drift it was
  measured to expose. `buildDriftPct` is usually the louder of the two and
  expected to be strongly negative — see the `buildMs` caveat below.

### Why the clock rate is a propagation axis

Propagation is not paid per frame. `SampledTrajectory.start` refreshes its sample
window on a **simulation-time** callback — every quarter of an orbital period — and
each refresh re-propagates 120 SGP4 samples per orbit for that satellite. So
refreshes per wall second are proportional to the multiplier: at ×1000 a quarter
orbit goes by in about a second and a half, where at ×1 it takes a quarter of an
orbit. Drawing does not care what the clock is doing, which is exactly what makes
the difference between two clock rates attributable to propagation.

A `usPerSatellite` that holds steady across counts at one rate says the cost is
per-satellite propagation and nothing else.

## Things that will bite you

- **The tab has to stay visible.** A hidden tab does not throttle
  `requestAnimationFrame`, it suspends it — no frames are presented at all, and
  every timing becomes noise. The sweep no longer wedges when that happens (each
  frame wait has a 1 s timeout), and it says so instead: `frames` on each row is
  the sample size, rows under 20 frames are struck through in the panel,
  `logRun` warns before the tables, and the run's environment records
  `visibility`. Read `frames` before believing anything else on a row.
- **The sweep drives `SatelliteManager.reconcile` directly, not the store.** It has
  to: `sceneSync` switches Label off above 200 active satellites, so a
  store-driven sweep could not measure labels at 1,000. The cost is that a store
  change mid-sweep would overwrite the scene — so don't touch the toolbar while
  it runs. `restore()` puts the store's scene, `requestRenderMode` and
  `shouldAnimate` back afterwards.
- **Render-on-demand is switched off as soon as the panel opens**, and put back when
  it closes. With it on, the gap between frames measures how idle the loop is rather
  than what a scene costs, so there is no reading to be had — which is why this is
  not offered as a choice. Switching it back on from the debug menu while the panel
  is open puts a warning across the top of the panel, beside the readout it
  invalidates. The clock is likewise forced to run for the duration of a sweep: a
  stopped clock means no position updates, and position updates are most of the cost.
- **`buildMs` is always measured at ×1**, whatever the step's clock rate. A step at
  ×1000 would otherwise sweep the sample window forward mid-build, so the build would
  carry propagation belonging to the measurement after it. The rate is applied once
  the scene is up, so the warmup absorbs the first refreshes at the new rate.
- **`cpuMs` excludes the clock tick.** Cesium runs `clock.onTick` — where sampled
  positions update — before `scene.preUpdate`, so per-satellite position work lands
  in `frameMs` but not in `cpuMs`. The gap between the two is the interesting part.
- **`buildMs` is not comparable across component sets.** The first pass over a
  population pays for whatever it warms up; a measured run had `Point` at 500
  satellites cost 3,245 ms to build and `Point + Orbit` at the same 500 cost
  399 ms — more drawing, an eighth of the time, because it was second. Compare
  `buildMs` down a column (rising counts within one set), never across sets. The
  drift table quantifies it directly: `buildDriftPct` is that same first-pass cost,
  measured rather than argued about. Whether it is satellite.js, the trajectory
  sampling or plain JIT warmup is the first thing this framework is worth pointing
  at.
- **`visible` may exceed the count requested.** Activation matches by _name_ and
  two catalog entries can share one, so asking for 500 drew 501. That is why the
  fits are computed against `visible` rather than the requested count.
- **Not every component applies to every satellite.** Ground track and sensor cone
  are drawn per orbit class, a 3D model needs a model url. `visible` and
  `componentInstances` are recorded for exactly this reason; check them before
  believing a flat line.
- **The whole catalog is loaded before the first step** (`catalog.ensureAll()`), so
  a run measures drawing rather than downloading. Counts are sliced from the sorted
  catalog, so "the first 500" is the same 500 every time — but which 500 depends on
  the route's preset, and their orbit classes decide what can be drawn. Pass
  `{ tag: "Starlink" }` to pin the population.
- **Ground stations are off by default.** One station switches pass prediction on
  for every satellite, which is a large cost that has nothing to do with drawing.
  Give it its own run.

## Shape

One file knows about Cesium. Everything else is pure and unit-tested
(`benchmark.test.ts`), which is what lets the analysis be trusted without a
browser in the loop:

- `frameSampler.ts` — timestamps in, percentiles out. No Cesium, no DOM.
- `benchmarkPlan.ts` — the three-axis sweep matrix, pure.
- `report.ts` — rows, the linear fits, the marginal-cost, propagation and drift
  differencing, csv/json.
- `benchmarkRunner.ts` — the loop, over a `BenchmarkTarget` interface.
- `cesiumBenchmarkTarget.ts` — the only file that knows what a viewer is.
- `index.ts` — the console handle, `window.bench`.
- `../../components/BenchmarkPanel.vue` — the in-browser half.

Nothing here is in the bundle a normal visitor downloads: the panel is an async
component, so the whole framework is a chunk that loads only when the switch goes
on, and it is excluded from the PWA precache (`vite.config.ts`) so the glob does
not pull it down anyway.

`CesiumPerformanceStats` (behind the `showFps` toggle) is separate and untouched.
It is deliberately not replaced: Cesium's own FPS counter is an independent second
opinion on the panel's headline figure, computed by code this framework does not
own, which is why the panel is positioned to leave it visible.

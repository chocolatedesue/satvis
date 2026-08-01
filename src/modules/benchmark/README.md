# Benchmarking framework — PROTOTYPE

**Throwaway.** This exists to answer one question, not to be maintained:

> How does satvis's frame cost scale with the number of satellites, and what does
> each satellite component cost on top of the ones already being drawn?

It replaces the console-paste script that used to be `src/modules/benchmark.ts`,
which measured average and worst frame time and printed one line per step. The
same idea, with the parts that made its numbers hard to trust fixed: percentiles
instead of an average and a max, warmup frames discarded, a build torn down
before the next one is timed, and what was _actually drawn_ recorded next to what
was asked for.

## Run it

```bash
pnpm bench
```

Builds and previews a production bundle, then opens `/?bench=1` with the panel up.
**Measure against this, not `pnpm dev`** — a dev build is unminified and runs Vue in
development mode, so its numbers are pessimistic by an unknown factor. (The panel is
also on by default under `pnpm dev`, for working on the panel itself.)

Then either use the panel, or the console:

```js
bench.quick(); // 3 counts × 7 isolated sets — checks the harness, ~2 min
bench.run(); // 9 counts × 7 isolated sets: each component's own cost
bench.cumulative(); // 9 counts × 8 growing sets: cost on top of what is already drawn
bench.run({ satelliteCounts: [0, 500, 5000], componentSets: [["Point", "Orbit"]] });
bench.run({ groundStation: { lat: 48.18, lon: 11.75 } }); // switches pass prediction on
bench.watch(); // log a live line every 2 s; returns a stop function
bench.cancel();
bench.log();
bench.csv();
bench.json();
bench.text();
```

Keep the tab in the foreground. A background tab is throttled to ~1 fps and every
row becomes a lie.

## What it measures

Per step (one satellite count × one component set):

| Column           | Meaning                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `fps`, `frameMs` | Between presented frames. What the user feels; flattens against vsync at 60/120 fps |
| `cpuMs`          | `preUpdate` → `postRender`. The work done, which keeps moving after fps has capped  |
| `p95`, `worst`   | Percentiles, not just a max — one 400 ms frame should not define a row              |
| `jankPct`        | Share of frames slower than 33 ms                                                   |
| `buildMs`        | The synchronous cost of building the scene: instantiation plus component creation   |
| `clearMs`        | Tearing the previous scene down                                                     |
| `visible`        | Satellites actually drawn, which is **not** always the count requested              |
| `drawn`          | Components actually drawn, when they differ from the ones requested                 |
| `heapMb`         | Chrome only, bucketed to 5 MB. A trend, not a figure                                |

And derived, across steps:

- **scaling** — a least-squares fit of `cpuMs` against the satellites drawn, per
  component set: ms per 1,000 satellites, the fixed cost at zero, r² (well under
  1.0 means the cost is _not_ linear in the count), and where 60 fps runs out.
- **marginal cost** — each set differenced against the largest set in the run that
  is a strict subset of it. In a cumulative sweep that is the cost of the component
  just added; in an isolated sweep it is that component's cost over a bare point.
  One function serves both.

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
- **`requestRenderMode` is forced off and the clock forced on** for the duration.
  With render-on-demand, frame deltas measure how idle the loop is; with a stopped
  clock there are no position updates, which are most of the cost.
- **`cpuMs` excludes the clock tick.** Cesium runs `clock.onTick` — where sampled
  positions update — before `scene.preUpdate`, so per-satellite position work lands
  in `frameMs` but not in `cpuMs`. The gap between the two is the interesting part.
- **`buildMs` is not comparable across component sets.** The first pass over a
  population pays for whatever it warms up; a measured run had `Point` at 500
  satellites cost 3,245 ms to build and `Point + Orbit` at the same 500 cost
  399 ms — more drawing, an eighth of the time, because it was second. Compare
  `buildMs` down a column (rising counts within one set), never across sets.
  Whether that first-pass cost is satellite.js, the trajectory sampling or plain
  JIT warmup is the first thing this framework is worth pointing at.
- **`visible` may exceed the count requested.** Activation matches by *name* and
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

The Cesium-bound part is one file. Everything else is portable, and is the part
worth lifting if this earns a permanent place:

- `frameSampler.ts` — timestamps in, percentiles out. No Cesium, no DOM.
- `benchmarkPlan.ts` — the sweep matrix, pure.
- `report.ts` — rows, the linear fits, the marginal-cost differencing, csv/json.
- `benchmarkRunner.ts` — the loop, over a `BenchmarkTarget` interface.
- `cesiumBenchmarkTarget.ts` — the only file that knows what a viewer is.
- `index.ts` — `window.bench`; `enabled.ts` — the `?bench` gate.
- `../../components/BenchmarkPanel.vue` — the in-browser half. Throwaway.

`CesiumPerformanceStats` (used by the `showFps` toggle) is untouched and still
does its own thing.

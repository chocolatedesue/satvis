// The one Cesium-bound piece: it turns "draw N satellites with these
// components" into a reconcile, and the render loop into frame samples.

import type { JulianDate } from "@cesium/engine";

import { useCesiumStore } from "../../stores/cesium";
import { useSatStore } from "../../stores/sat";
import type { CesiumController } from "../CesiumController";
import type { DesiredScene } from "../SatelliteManager";
import type { BenchmarkTarget, FootprintSample, MeasureOptions, SceneApplied, SceneRequest } from "./benchmarkRunner";
import { FrameSampler, type FrameSample } from "./frameSampler";

declare global {
  /**
   * `performance.measureUserAgentSpecificMemory()`, absent from the TypeScript dom
   * lib because it is not Baseline. Declared here rather than cast at the call
   * site so the shape is stated once.
   */
  interface MemoryMeasurement {
    bytes: number;
    breakdown: Array<{ bytes: number; types: string[]; attribution: Array<{ url: string; scope: string }> }>;
  }

  interface Performance {
    measureUserAgentSpecificMemory?: () => Promise<MemoryMeasurement>;
    // Chrome only. The comment here used to claim 5 MB buckets unless started
    // with --enable-precise-memory-info; measured on Chrome in 2026 that is not
    // so — eight consecutive reads gave eight distinct non-round values with and
    // without the flag. What makes a single read useless is not granularity but
    // uncollected garbage. See FrameSample.heap.
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }
}

/** About two seconds at 60 fps — enough for the live readout to be steady. */
const LIVE_WINDOW_FRAMES = 120;

const BYTES_PER_MB = 1024 * 1024;

/** A GPU query result is usually a frame or two away; give up rather than leak. */
const GPU_QUERY_POLL_MS = 4;
const GPU_QUERY_MAX_POLLS = 250;

export interface LiveSnapshot {
  frames: FrameSample;
  satellitesVisible: number;
  componentsDrawn: string[];
  clockMultiplier: number;
  entities: number;
  primitives: number;
}

export interface TargetOptions {
  /**
   * Restrict the sweep to satellites carrying this tag. Unset means the whole
   * loaded catalog, which is what makes the counts reachable on any route
   * rather than only where a big enough group happens to be configured.
   */
  tag?: string;
  /**
   * Place a ground station, which switches pass prediction on for every
   * satellite. Off by default: it is a large cost that has nothing to do with
   * drawing, so it belongs in its own run rather than in every row.
   */
  groundStation?: { lat: number; lon: number };
}

/**
 * How long to let the app go quiet before reading the footprint.
 *
 * Long enough for the sample-window top-ups already in flight to land and their
 * buffers to become collectable. Six seconds was where the reading stopped moving:
 * the same scene read 550 MB at +6 s and 544 MB at +16 s, against 1044 and 1295 MB
 * with the clock running.
 */
const FOOTPRINT_QUIESCE_MS = 6000;

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Wait for `count` presented frames — but never forever.
 *
 * A hidden tab does not throttle requestAnimationFrame, it suspends it, so
 * without the timeout a sweep started and then backgrounded wedges on step one
 * and never reports anything. The timeout means it carries on instead, and the
 * `frames` column is what says the sample was worthless.
 */
const nextFrames = (count: number, timeoutMs = 1000): Promise<void> =>
  new Promise((resolve) => {
    let remaining = count;
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const step = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        done();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

/**
 * Where one GPU reading belongs: the sampler that was collecting when the query
 * was started, and the epoch it was then on. See `#endGpuQuery`.
 */
interface GpuTarget {
  sampler: FrameSampler;
  epoch: number;
}

/**
 * Whether this page can measure an absolute footprint at all.
 *
 * Two conditions, and the isolation one is the interesting half: the API is only
 * exposed to a cross-origin isolated context, so a page served without
 * `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: credentialless` cannot see it however new the
 * browser. That is a deployment fact rather than a browser fact, which is why the
 * panel says which of the two is missing instead of just greying a control.
 */
export const canMeasureFootprint = (): boolean => window.crossOriginIsolated && typeof performance.measureUserAgentSpecificMemory === "function";

/** Best effort, and separate from Cesium's context so nothing internal is poked. */
function gpuName(): string {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return info ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
  } catch {
    return "unknown";
  }
}

export class CesiumBenchmarkTarget implements BenchmarkTarget {
  readonly #cc: CesiumController;

  readonly #live = new FrameSampler(LIVE_WINDOW_FRAMES);

  #sweep: FrameSampler | undefined;

  #preUpdateAt = 0;

  /** Duration of the clock tick that preceded the frame being rendered. See #instrumentClockTick. */
  #tickMs = 0;

  /** `EXT_disjoint_timer_query_webgl2`, or undefined where the browser has no such thing. */
  #timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | undefined;

  #gl: WebGL2RenderingContext | undefined;

  /**
   * At most one query in flight. Beginning one per frame would queue hundreds of
   * query objects and force a flush on each; one at a time samples a subset of
   * frames, which is all a median needs.
   */
  #queryInFlight: { query: WebGLQuery; targets: GpuTarget[] } | undefined;

  options: TargetOptions = {};

  /**
   * What the app looked like before the first prepare(), so restore() can put it
   * back. Held until restore rather than per run, because a run that throws
   * still has to give the user their scene back.
   */
  #saved: { requestRenderMode: boolean; shouldAnimate: boolean; multiplier: number; scene: DesiredScene } | undefined;

  constructor(cc: CesiumController) {
    this.#cc = cc;
    const { scene } = cc.viewer;
    // Two marks per frame: the wall clock between presented frames comes from
    // postRender alone, and the work inside one frame needs both. Cesium runs
    // most position updates in clock onTick, before preUpdate, so measuring
    // from preUpdate deliberately excludes them — see README.
    this.#initGpuTimer(scene);
    this.#instrumentClockTick();
    scene.preUpdate.addEventListener(() => {
      this.#preUpdateAt = performance.now();
      this.#beginGpuQuery();
    });
    scene.postRender.addEventListener(() => {
      const now = performance.now();
      const cpuMs = now - this.#preUpdateAt;
      this.#live.push(now, cpuMs, this.#tickMs);
      this.#sweep?.push(now, cpuMs, this.#tickMs);
      // After the timing marks, so the read is never inside what it would
      // otherwise inflate. Per frame rather than once per step because a single
      // reading measures when the last GC happened, not what the scene costs.
      const bytes = performance.memory?.usedJSHeapSize;
      if (bytes !== undefined) {
        const mb = bytes / BYTES_PER_MB;
        this.#live.pushHeap(mb);
        this.#sweep?.pushHeap(mb);
      }
      this.#endGpuQuery();
    });
  }

  /**
   * The GPU-side clock. Optional in every sense: the extension is absent on some
   * browsers, blocked on others, and — as measured on ANGLE/Metal — can return
   * times several multiples of the frame interval, which is why nothing here
   * trusts the number on sight. The report gates it; this only collects it.
   */
  #initGpuTimer(scene: object): void {
    try {
      // `context` is Cesium-internal and untyped; reaching for it is the only way
      // to time the GPU on the context the app is actually drawing with.
      const gl = (scene as { context?: { _gl?: WebGL2RenderingContext } }).context?._gl;
      const ext = gl?.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
      if (gl && ext) {
        this.#gl = gl;
        this.#timerExt = ext;
      }
    } catch {
      // A missing or blocked extension is not worth a broken benchmark.
    }
  }

  #beginGpuQuery(): void {
    const gl = this.#gl;
    const ext = this.#timerExt;
    if (!gl || !ext || this.#queryInFlight) {
      return;
    }
    try {
      const query = gl.createQuery();
      if (!query) {
        return;
      }
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      const targets: GpuTarget[] = [{ sampler: this.#live, epoch: this.#live.epoch }];
      if (this.#sweep) {
        targets.push({ sampler: this.#sweep, epoch: this.#sweep.epoch });
      }
      this.#queryInFlight = { query, targets };
    } catch {
      this.#timerExt = undefined;
    }
  }

  #endGpuQuery(): void {
    const gl = this.#gl;
    const ext = this.#timerExt;
    const pending = this.#queryInFlight;
    if (!gl || !ext || !pending) {
      return;
    }
    const { query, targets } = pending;
    this.#queryInFlight = undefined;
    try {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
    } catch {
      gl.deleteQuery(query);
      this.#timerExt = undefined;
      return;
    }
    // The result lands some frames later, so poll rather than block — and it is
    // delivered to the samplers this query was *started* for, at the epoch they
    // were then on. Delivering it to whatever was open on arrival is what made this
    // column untrustworthy: a query from the tail of a heavy step landed in the
    // next step's window, and a query from a warmup frame landed in the sample the
    // warmup exists to protect. A 5,000-satellite step reported 34.5 ms and the
    // 0-satellite step after it reported 24.
    let attempts = 0;
    const poll = (): void => {
      attempts += 1;
      try {
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          // A disjoint means the GPU was interrupted and the timing is garbage.
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
            const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
            for (const target of targets) {
              if (target.sampler.epoch === target.epoch) {
                target.sampler.pushGpu(ns / 1e6);
              }
            }
          }
          gl.deleteQuery(query);
          return;
        }
        if (attempts > GPU_QUERY_MAX_POLLS) {
          gl.deleteQuery(query);
          return;
        }
        setTimeout(poll, GPU_QUERY_POLL_MS);
      } catch {
        this.#timerExt = undefined;
      }
    };
    setTimeout(poll, GPU_QUERY_POLL_MS);
  }

  /** True when this browser offered a GPU clock at all. */
  get gpuTimingAvailable(): boolean {
    return this.#timerExt !== undefined;
  }

  /** The in-browser readout, sampled continuously whether a sweep is running or not. */
  live(): LiveSnapshot {
    return {
      frames: this.#live.snapshot(),
      satellitesVisible: this.#cc.sats.visibleSatellites.length,
      componentsDrawn: this.#cc.sats.enabledComponents,
      clockMultiplier: this.#cc.viewer.clock.multiplier,
      entities: this.#cc.viewer.entities.values.length,
      primitives: this.#cc.viewer.scene.primitives.length,
    };
  }

  environment(): Record<string, string | number> {
    const { canvas } = this.#cc.viewer.scene;
    return {
      build: `${__BUILD_SHA__} ${__BUILD_DATE__}`,
      mode: import.meta.env.DEV ? "dev (unminified — numbers are pessimistic)" : "production build",
      userAgent: navigator.userAgent,
      gpu: gpuName(),
      canvas: `${canvas.width}x${canvas.height}`,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      // Recorded because it invalidates the whole run: a hidden tab presents no
      // frames at all, so every frame figure below would be noise.
      visibility: document.visibilityState,
      // Whether an absolute footprint was obtainable, which is a property of how
      // the page was served rather than of the machine.
      crossOriginIsolated: String(window.crossOriginIsolated),
    };
  }

  /**
   * Time the whole clock tick, by wrapping `clock.tick` rather than by adding a
   * listener to `clock.onTick`.
   *
   * Position updates happen in `onTick` listeners, and an `onTick` listener of
   * our own could only mark the point it is *itself* reached. Cesium raises
   * listeners in registration order, and two of the ones that matter — the
   * manager's derived-geometry refresh and the orbit batch's re-orientation —
   * are registered when the viewer is built, long before the panel that
   * constructs this target. A marker would sit behind them and quietly miss
   * exactly the work it was added to find.
   *
   * `clock.tick()` raises the event, so wrapping it captures every listener
   * whatever the order, which is the only version of this that cannot be wrong.
   * The cost is two `performance.now()` calls a frame, and it is only ever
   * installed in a session that has opened the benchmark panel.
   */
  #instrumentClockTick(): void {
    const { clock } = this.#cc.viewer;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = clock.tick;
    if ((original as { __benchmarkWrapped?: boolean }).__benchmarkWrapped) {
      return;
    }
    const wrapped = (): JulianDate => {
      const started = performance.now();
      try {
        return original.call(clock);
      } finally {
        this.#tickMs = performance.now() - started;
      }
    };
    (wrapped as { __benchmarkWrapped?: boolean }).__benchmarkWrapped = true;
    clock.tick = wrapped;
  }

  async prepare(): Promise<void> {
    const { clock } = this.#cc.viewer;
    const cesiumStore = useCesiumStore();
    this.#saved ??= { requestRenderMode: cesiumStore.requestRenderMode, shouldAnimate: clock.shouldAnimate, multiplier: clock.multiplier, scene: this.#storeScene() };
    // requestRenderMode skips frames when nothing moved, which would make the
    // frame deltas measure how idle the render loop is rather than how much a
    // scene costs. The clock has to run for the same reason: a stopped clock
    // means no position updates, and position updates are most of the cost.
    //
    // Through the store so the Render menu's switch follows: a sweep started from
    // the console with the panel closed still changes this, and a control showing
    // the opposite of what is in force is worse than no control.
    cesiumStore.requestRenderMode = false;
    clock.shouldAnimate = true;
    // Every count is sliced out of the loaded catalog, so the whole catalog has
    // to be there first — otherwise the sweep measures group downloads.
    await this.#cc.sats.catalog.ensureAll();
  }

  catalogSize(): number {
    return this.#names().length;
  }

  async apply(request: SceneRequest): Promise<SceneApplied> {
    const names = this.#names().slice(0, request.satelliteCount);
    const { clock } = this.#cc.viewer;

    // The clock is set back to real time for the build. A step at ×1000 would
    // otherwise sweep the sample window forward while the scene is being
    // constructed, so `buildMs` would carry a propagation cost belonging to the
    // measurement that follows it.
    clock.multiplier = 1;

    // Clear first, so buildMs is the cost of building this scene rather than
    // the cost of the diff from the previous one.
    const clearStart = performance.now();
    this.#cc.sats.reconcile(this.#scene([], []));
    const clearMs = performance.now() - clearStart;
    await nextFrames(2);

    // `buildMs` is the wall time to a complete scene, not the synchronous part
    // of the call. Satellites are instantiated to a per-frame budget now (see
    // SatelliteManager.#build), so reconcile returns with the queue still
    // draining — without the await, every row would report whatever fraction of
    // the population happened to exist when the first frame ended.
    const buildStart = performance.now();
    this.#cc.sats.reconcile(this.#scene(names, request.components));
    await this.#cc.sats.buildSettled();
    const buildMs = performance.now() - buildStart;
    await nextFrames(2);

    // Only now, so the warmup period absorbs the first refreshes at the new rate.
    clock.multiplier = request.clockMultiplier;

    const satellites = this.#cc.sats.visibleSatellites;
    const componentInstances: Record<string, number> = {};
    for (const satellite of satellites) {
      for (const component of satellite.componentNames) {
        componentInstances[component] = (componentInstances[component] ?? 0) + 1;
      }
    }
    return {
      satellitesRequested: request.satelliteCount,
      satellitesVisible: satellites.length,
      componentsRequested: [...request.components],
      componentsDrawn: this.#cc.sats.enabledComponents,
      componentInstances,
      clockMultiplier: clock.multiplier,
      entities: this.#cc.viewer.entities.values.length,
      primitives: this.#cc.viewer.scene.primitives.length,
      clearMs,
      buildMs,
    };
  }

  async measure(options: MeasureOptions): Promise<FrameSample> {
    const sampler = new FrameSampler();
    this.#sweep = sampler;
    try {
      await wait(options.warmupMs, options.signal);
      // The warmup frames are thrown away, not averaged in: the first frames
      // after a build carry shader compiles and buffer uploads that a steady
      // state does not.
      sampler.reset();
      await wait(options.sampleMs, options.signal);
      return sampler.snapshot();
    } finally {
      this.#sweep = undefined;
    }
  }

  /**
   * An absolute footprint for the scene currently up.
   *
   * The `JavaScript`/`Window` breakdown entry is singled out as `jsMb` because it
   * is the figure comparable with everything else here — `measureUAM`'s total also
   * counts DOM and shared memory across workers, which is a broader thing than the
   * heap the rest of the framework talks about. Both are kept: the total is the
   * honest answer to "what does this tab cost", and measured they are far apart
   * (427 MB against 297 MB at 5,000 satellites).
   */
  async measureFootprint(): Promise<FootprintSample | undefined> {
    const measure = performance.measureUserAgentSpecificMemory;
    if (!canMeasureFootprint() || !measure) {
      return undefined;
    }
    const startedAt = performance.now();
    // Stop the clock and let the app go quiet first, which is the difference
    // between measuring a scene and measuring the garbage it happens to be
    // producing. At 5,000 satellites with orbits the app propagates and
    // re-transforms sample windows continuously, and the reading lands wherever
    // that churn is at the time — measured on one scene, seconds apart:
    //
    //     clock running   1044 MB total (worker 557)   then 1295 MB (window 1106)
    //     clock stopped    550 MB total (worker  51)   then  544 MB (window  357)
    //
    // so the running figures were a factor of two and a half apart on a scene that
    // had not changed. Safe to do here and nowhere else: the footprint is captured
    // after the sample window has closed, so no frame timing can see it.
    const clock = this.#cc.viewer.clock;
    const wasAnimating = clock.shouldAnimate;
    clock.shouldAnimate = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, FOOTPRINT_QUIESCE_MS));
      const result = await measure.call(performance);
      const js = result.breakdown.find((entry) => entry.types.includes("JavaScript") && entry.attribution.some((item) => item.scope === "Window"));
      // Separated out because `totalMb` counts them and nothing else does — see
      // FootprintSample.workerMb.
      const workerBytes = result.breakdown.filter((entry) => entry.attribution.some((item) => (item.scope ?? "").includes("Worker"))).reduce((sum, entry) => sum + entry.bytes, 0);
      return {
        totalMb: result.bytes / BYTES_PER_MB,
        jsMb: (js?.bytes ?? result.bytes) / BYTES_PER_MB,
        workerMb: workerBytes / BYTES_PER_MB,
        elapsedMs: performance.now() - startedAt,
      };
    } catch {
      // A rejected measurement is a missing row, not a failed sweep: the API can
      // refuse (a detached frame, a browser that changed its mind) and the run
      // still has every frame timing it came for.
      return undefined;
    } finally {
      clock.shouldAnimate = wasAnimating;
    }
  }

  async restore(): Promise<void> {
    const saved = this.#saved;
    if (!saved) {
      return;
    }
    const { clock } = this.#cc.viewer;
    useCesiumStore().requestRenderMode = saved.requestRenderMode;
    clock.shouldAnimate = saved.shouldAnimate;
    clock.multiplier = saved.multiplier;
    // The sweep drove the manager directly, so the store's scene has to be put
    // back by hand — sceneSync's watcher only fires when the store changes, and
    // the store never changed.
    this.#cc.sats.reconcile(this.#storeScene());
    this.#saved = undefined;
    await nextFrames(1);
  }

  /**
   * Names in a stable order, so "the first 500" is the same 500 whatever order
   * the groups happened to load in and whichever run this is. Deduplicated
   * because activation matches by name and two catalog entries may share one.
   */
  #names(): string[] {
    const entries = this.options.tag ? this.#cc.sats.catalog.entriesWithTag(this.options.tag) : this.#cc.sats.catalog.entries;
    // eslint-disable-next-line unicorn/no-array-sort -- already a fresh array
    return [...new Set(entries.map((entry) => entry.name))].sort();
  }

  #scene(enabledSatellites: string[], components: readonly string[]): DesiredScene {
    const station = this.options.groundStation;
    return {
      enabledTags: [],
      enabledSatellites,
      disabledSatellites: [],
      components: [...components],
      groundStations: station ? [{ lat: station.lat, lon: station.lon, name: "Benchmark" }] : [],
      overpassMode: "elevation",
      trackedSatellite: "",
      // Fixed rather than read from the store: illumination colouring costs a
      // per-frame callback per point, and a benchmark row has to mean the same
      // thing whatever the user last left the paint mode on.
      pointColorMode: "class",
      panelAxis: "zenith",
    };
  }

  /** The scene the store currently wants, which is what restore() puts back. */
  #storeScene(): DesiredScene {
    const store = useSatStore();
    return {
      enabledTags: [...store.enabledTags],
      enabledSatellites: [...store.enabledSatellites],
      disabledSatellites: [...store.disabledSatellites],
      components: [...store.enabledComponents],
      groundStations: store.groundStations.map((station) => ({ ...station })),
      overpassMode: store.overpassMode,
      trackedSatellite: store.trackedSatellite,
      pointColorMode: store.pointColorMode,
      panelAxis: store.panelAxis,
    };
  }
}

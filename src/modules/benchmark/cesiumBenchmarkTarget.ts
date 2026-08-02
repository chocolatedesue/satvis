// The one Cesium-bound piece: it turns "draw N satellites with these
// components" into a reconcile, and the render loop into frame samples.

import { useCesiumStore } from "../../stores/cesium";
import { useSatStore } from "../../stores/sat";
import type { CesiumController } from "../CesiumController";
import type { DesiredScene } from "../SatelliteManager";
import type { BenchmarkTarget, MeasureOptions, SceneApplied, SceneRequest } from "./benchmarkRunner";
import { FrameSampler, type FrameSample } from "./frameSampler";

declare global {
  interface Performance {
    // Chrome only, and coarse (bucketed to 5 MB unless the browser was started
    // with --enable-precise-memory-info). Useful as a trend, not as a figure.
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }
}

/** About two seconds at 60 fps — enough for the live readout to be steady. */
const LIVE_WINDOW_FRAMES = 120;

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
  heapMb: number | undefined;
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

  /** `EXT_disjoint_timer_query_webgl2`, or undefined where the browser has no such thing. */
  #timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | undefined;

  #gl: WebGL2RenderingContext | undefined;

  /**
   * At most one query in flight. Beginning one per frame would queue hundreds of
   * query objects and force a flush on each; one at a time samples a subset of
   * frames, which is all a median needs.
   */
  #queryInFlight: WebGLQuery | undefined;

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
    scene.preUpdate.addEventListener(() => {
      this.#preUpdateAt = performance.now();
      this.#beginGpuQuery();
    });
    scene.postRender.addEventListener(() => {
      const now = performance.now();
      const cpuMs = now - this.#preUpdateAt;
      this.#live.push(now, cpuMs);
      this.#sweep?.push(now, cpuMs);
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
      this.#queryInFlight = query;
    } catch {
      this.#timerExt = undefined;
    }
  }

  #endGpuQuery(): void {
    const gl = this.#gl;
    const ext = this.#timerExt;
    const query = this.#queryInFlight;
    if (!gl || !ext || !query) {
      return;
    }
    this.#queryInFlight = undefined;
    try {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
    } catch {
      gl.deleteQuery(query);
      this.#timerExt = undefined;
      return;
    }
    // The result lands some frames later, so poll rather than block. A frame
    // whose timing arrives after its sample window closed simply joins the next
    // one — the population is a median, not a per-frame pairing.
    let attempts = 0;
    const poll = (): void => {
      attempts += 1;
      try {
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          // A disjoint means the GPU was interrupted and the timing is garbage.
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
            const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
            this.#live.pushGpu(ns / 1e6);
            this.#sweep?.pushGpu(ns / 1e6);
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
    const bytes = this.memoryBytes();
    return {
      frames: this.#live.snapshot(),
      satellitesVisible: this.#cc.sats.visibleSatellites.length,
      componentsDrawn: this.#cc.sats.enabledComponents,
      clockMultiplier: this.#cc.viewer.clock.multiplier,
      entities: this.#cc.viewer.entities.values.length,
      primitives: this.#cc.viewer.scene.primitives.length,
      heapMb: bytes === undefined ? undefined : bytes / 1024 / 1024,
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
    };
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
    // Through the store so the debug menu's switch follows: a sweep started from
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

    const buildStart = performance.now();
    this.#cc.sats.reconcile(this.#scene(names, request.components));
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

  memoryBytes(): number | undefined {
    return performance.memory?.usedJSHeapSize;
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
    };
  }
}

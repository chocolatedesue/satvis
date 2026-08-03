// The sweep loop, over an injected target. Nothing here knows about Cesium,
// Vue or the DOM: it decides what to measure and in what order, and the target
// decides what "apply this scene" means.

import { buildPlan, type BenchmarkStep, type PlanSpec } from "./benchmarkPlan";
import type { FrameSample } from "./frameSampler";

export interface SceneRequest {
  satelliteCount: number;
  components: readonly string[];
  clockMultiplier: number;
}

/**
 * What the app actually built, as against what was asked for. Recorded rather
 * than assumed because the two genuinely differ: a name can match two catalog
 * entries, and a component is only created for satellites it applies to (no
 * sensor cone without a swath, no model without a model url). A row that
 * claimed 5,000 labels when 200 were drawn would be worse than no row.
 */
export interface SceneApplied {
  satellitesRequested: number;
  satellitesVisible: number;
  componentsRequested: string[];
  componentsDrawn: string[];
  componentInstances: Record<string, number>;
  /** Recorded rather than read back off the step: the clock is the app's to refuse. */
  clockMultiplier: number;
  entities: number;
  primitives: number;
  /** Tearing the previous scene down, so a build is never a diff from one. */
  clearMs: number;
  /** Wall time of the synchronous build — instantiation plus component creation. */
  buildMs: number;
}

export interface MeasureOptions {
  warmupMs: number;
  sampleMs: number;
  signal: AbortSignal;
}

/**
 * An absolute memory measurement, garbage excluded — as against the relative
 * slope `memoryFits` derives from sampled heap floors.
 *
 * From `performance.measureUserAgentSpecificMemory()`, which is why it is
 * optional in every sense: the API needs a cross-origin isolated context and
 * exists only in Chromium, and it resolves only when a collection happens, which
 * measured at 14-19 s a call. That cost is why capturing this is a choice rather
 * than something every sweep does.
 */
export interface FootprintSample {
  /** The whole agent: JavaScript, DOM and shared memory, across every scope. */
  totalMb: number;
  /**
   * Just this window's JavaScript. The figure comparable with `memoryFits` and
   * with a forced collection — measured 0.2% apart from one.
   */
  jsMb: number;
  /** How long the call took, so a row records what it cost to have this number. */
  elapsedMs: number;
}

export interface BenchmarkTarget {
  /** Facts about the machine, so a result set can be compared with another. */
  environment(): Record<string, string | number>;
  /** Everything that has to be true before the first step, once per run. */
  prepare(): Promise<void>;
  /** How many satellites are available to draw at all. */
  catalogSize(): number;
  apply(request: SceneRequest): Promise<SceneApplied>;
  /**
   * Sample the window. The heap is part of the returned frame sample rather than
   * a separate reading taken afterwards — see `FrameSample.heap`.
   */
  measure(options: MeasureOptions): Promise<FrameSample>;
  /**
   * The absolute footprint of the scene currently up, or undefined where this
   * browser cannot answer. Called after the sample window and before the next
   * step tears the scene down, so the figure belongs to the scene it is filed
   * under — and never during the window, since a 17 s wait inside a 4 s sample
   * would not be a sample.
   */
  measureFootprint(): Promise<FootprintSample | undefined>;
  /** Put the app back the way it was found. */
  restore(): Promise<void>;
}

export interface BenchmarkOptions {
  warmupMs: number;
  sampleMs: number;
  /**
   * Capture an absolute footprint per step. Off by default because it is the
   * most expensive thing in the framework — see `FootprintSample`.
   */
  captureFootprint?: boolean;
}

/**
 * What one footprint capture costs, for the duration estimate. Measured over six
 * calls: 14, 16, 19, 16, 18 and 19 s. It is a wait for a collection rather than
 * work, so it does not scale with the scene.
 */
export const FOOTPRINT_CAPTURE_MS = 17_000;

/**
 * Long enough that a step is a measurement rather than a glance. The warmup has
 * to outlast the shader compiles and buffer uploads that follow a build, and the
 * sample has to span several of the sampled-trajectory refreshes that arrive on
 * a schedule of their own — a short sample either catches one or misses it, and
 * the row swings either way.
 */
export const DEFAULT_OPTIONS: BenchmarkOptions = { warmupMs: 2000, sampleMs: 4000 };

export interface BenchmarkResult {
  step: BenchmarkStep;
  applied: SceneApplied;
  frames: FrameSample;
  /** Present only when asked for, and only where the browser can answer. */
  footprint: FootprintSample | undefined;
}

export interface BenchmarkRun {
  startedAtIso: string;
  /**
   * The sweep that was asked for. Recorded because a run started from the console
   * has to be legible in the panel: without it the controls would go on showing
   * whatever was last typed while a different sweep ran.
   */
  spec: PlanSpec;
  environment: Record<string, string | number>;
  options: BenchmarkOptions;
  catalogSize: number;
  results: BenchmarkResult[];
  cancelled: boolean;
}

export interface RunnerHooks {
  onLog?(message: string): void;
  onProgress?(progress: { done: number; total: number; step: BenchmarkStep }): void;
  /** Called as each row lands, so a live table does not wait for the sweep. */
  onResult?(result: BenchmarkResult, run: BenchmarkRun): void;
}

export class BenchmarkRunner {
  readonly #target: BenchmarkTarget;

  #abort: AbortController | undefined;

  #current: BenchmarkRun | undefined;

  constructor(target: BenchmarkTarget) {
    this.#target = target;
  }

  get running(): boolean {
    return this.#current !== undefined;
  }

  /** The run in progress, or the last one to finish. */
  get run(): BenchmarkRun | undefined {
    return this.#current ?? this.#last;
  }

  #last: BenchmarkRun | undefined;

  cancel(): void {
    this.#abort?.abort();
  }

  async start(spec: PlanSpec, options: BenchmarkOptions = DEFAULT_OPTIONS, hooks: RunnerHooks = {}): Promise<BenchmarkRun> {
    if (this.#current) {
      throw new Error("A benchmark is already running");
    }
    const abort = new AbortController();
    this.#abort = abort;

    await this.#target.prepare();
    const steps = buildPlan(spec);
    const run: BenchmarkRun = {
      startedAtIso: new Date().toISOString(),
      spec,
      environment: this.#target.environment(),
      options,
      catalogSize: this.#target.catalogSize(),
      results: [],
      cancelled: false,
    };
    this.#current = run;
    hooks.onLog?.(`${steps.length} steps over a catalog of ${run.catalogSize} satellites`);

    try {
      for (const step of steps) {
        if (abort.signal.aborted) {
          run.cancelled = true;
          break;
        }
        hooks.onProgress?.({ done: run.results.length, total: steps.length, step });
        // Sequential is the whole point: two steps measured at once would be
        // measuring each other.
        // eslint-disable-next-line no-await-in-loop
        const applied = await this.#target.apply({ satelliteCount: step.satelliteCount, components: step.components, clockMultiplier: step.clockMultiplier });
        // eslint-disable-next-line no-await-in-loop
        const frames = await this.#target.measure({ ...options, signal: abort.signal });
        if (abort.signal.aborted) {
          // A sample cut short is not a sample. Drop it rather than record a
          // fast-looking row that only measured the moment before the stop.
          run.cancelled = true;
          break;
        }
        // After the sample window, with the scene still up: this is the one
        // measurement that must not happen inside the window it describes.
        // eslint-disable-next-line no-await-in-loop
        const footprint = options.captureFootprint ? await this.#target.measureFootprint() : undefined;
        const result: BenchmarkResult = { step, applied, frames, footprint };
        run.results.push(result);
        hooks.onResult?.(result, run);
      }
    } finally {
      await this.#target.restore();
      this.#last = run;
      this.#current = undefined;
      this.#abort = undefined;
    }
    hooks.onLog?.(run.cancelled ? `cancelled after ${run.results.length} steps` : `finished ${run.results.length} steps`);
    return run;
  }
}

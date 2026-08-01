// PROTOTYPE — see ./README.md.
//
// The sweep loop, over an injected target. Nothing here knows about Cesium,
// Vue or the DOM: it decides what to measure and in what order, and the target
// decides what "apply this scene" means.

import { buildPlan, type BenchmarkStep, type PlanSpec } from "./benchmarkPlan";
import type { FrameSample } from "./frameSampler";

export interface SceneRequest {
  satelliteCount: number;
  components: readonly string[];
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

export interface BenchmarkTarget {
  /** Facts about the machine, so a result set can be compared with another. */
  environment(): Record<string, string | number>;
  /** Everything that has to be true before the first step, once per run. */
  prepare(): Promise<void>;
  /** How many satellites are available to draw at all. */
  catalogSize(): number;
  apply(request: SceneRequest): Promise<SceneApplied>;
  measure(options: MeasureOptions): Promise<FrameSample>;
  memoryBytes(): number | undefined;
  /** Put the app back the way it was found. */
  restore(): Promise<void>;
}

export interface BenchmarkOptions {
  warmupMs: number;
  sampleMs: number;
}

export const DEFAULT_OPTIONS: BenchmarkOptions = { warmupMs: 1500, sampleMs: 3000 };

export interface BenchmarkResult {
  step: BenchmarkStep;
  applied: SceneApplied;
  frames: FrameSample;
  heapMb: number | undefined;
}

export interface BenchmarkRun {
  startedAtIso: string;
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

const BYTES_PER_MB = 1024 * 1024;

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
        const applied = await this.#target.apply({ satelliteCount: step.satelliteCount, components: step.components });
        // eslint-disable-next-line no-await-in-loop
        const frames = await this.#target.measure({ ...options, signal: abort.signal });
        if (abort.signal.aborted) {
          // A sample cut short is not a sample. Drop it rather than record a
          // fast-looking row that only measured the moment before the stop.
          run.cancelled = true;
          break;
        }
        const bytes = this.#target.memoryBytes();
        const result: BenchmarkResult = { step, applied, frames, heapMb: bytes === undefined ? undefined : bytes / BYTES_PER_MB };
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

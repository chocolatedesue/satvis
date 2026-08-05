// Frame timing collection. Free of Cesium and the DOM: whoever has the
// timestamps pushes them in.

/** Below 30 fps a frame is felt rather than merely measured. */
export const JANK_MS = 1000 / 30;

export interface SeriesStats {
  count: number;
  mean: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Percentiles over a copy, so the caller's array keeps its arrival order. */
export function seriesStats(values: readonly number[]): SeriesStats | undefined {
  if (values.length === 0) {
    return undefined;
  }
  // The spread is the copy the rule asks for; toSorted is past the ES2022 lib.
  // eslint-disable-next-line unicorn/no-array-sort
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile: number): number => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] as number;
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    mean: sum / values.length,
    min: sorted[0] as number,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] as number,
  };
}

export interface FrameSample {
  frames: number;
  elapsedMs: number;
  fps: number;
  /**
   * Time between consecutive presented frames — what the user feels, and what
   * a vsync ceiling of 60 or 120 fps shows up in.
   */
  wall: SeriesStats | undefined;
  /**
   * Time inside one render — Cesium's preUpdate to postRender. The work the app
   * actually did, which is the number that keeps moving after wall time has
   * flattened against vsync.
   *
   * Note what this is *not*: Cesium advances the clock and runs every `onTick`
   * listener before `preUpdate`, so per-satellite position work is outside it.
   * That is `tick`.
   */
  cpu: SeriesStats | undefined;
  /**
   * Time inside `clock.tick()` — the whole of it, every `onTick` listener
   * included. This is where propagation lives: the sampled-position windows are
   * refreshed from a simulation-time callback, so the faster the clock runs the
   * more of this there is, and none of it appears in `cpu`.
   *
   * Measured at 5,000 satellites drawing points and nothing else, this is the
   * difference between a row that reads 1.2 ms of cpu at 2.2 fps and a row that
   * says where the other 460 ms went.
   */
  tick: SeriesStats | undefined;
  /**
   * Time the GPU spent on one frame, from `EXT_disjoint_timer_query_webgl2`.
   *
   * A separate population from `wall` and `cpu` rather than a third value on
   * each frame: a query's result arrives several frames after the frame it
   * timed, and only some frames are sampled at all, so its count is its own.
   * Undefined where the extension is missing — and note the driver can still
   * lie even where it is present, which is why the report gates it against the
   * frame interval rather than printing whatever comes back.
   */
  gpu: SeriesStats | undefined;
  /**
   * Heap size in MB, sampled once per frame across the window.
   *
   * A population rather than one reading, because one reading is not a
   * measurement of anything: `usedJSHeapSize` counts garbage that has not been
   * collected yet, and a page cannot force a collection. The single post-sample
   * reading this replaces read 86 MB and 462 MB on consecutive passes over the
   * same scene, purely by which side of a major GC it landed on.
   *
   * What the window buys is `min` and `max` — and be clear about what each is
   * worth, because it is less than it looks:
   *
   * - **`min` is not the live set.** A major collection rarely lands inside a
   *   4 s window, so the low-water mark is mostly the heap as the window opened,
   *   accumulated garbage included. Measured over three identical sweeps, the
   *   zero-satellite step read 59, 436 and 270 MB against a true live set of
   *   39.5 MB. Read it as a *relative* figure: the difference down a column
   *   within one sweep cancels the offset, and did so to about 1% (a 5,000
   *   satellite scene came out +269.9 and +269.4 MB over its own zero row on two
   *   consecutive passes).
   * - **`max - min` is the allocation rate** over the window, and repeats well:
   *   13 MB at zero satellites, 24 MB at 1,000, 31 MB at 5,000.
   *
   * For an absolute number there is no substitute for a collection nobody can
   * ask for from script — DevTools, or `HeapProfiler.collectGarbage` over CDP.
   *
   * Undefined outside Chrome. Granularity is not the problem — measured, eight
   * consecutive reads give eight distinct non-round values, with or without
   * `--enable-precise-memory-info` — uncollected garbage is.
   */
  heap: SeriesStats | undefined;
  jankFrames: number;
  jankRatio: number;
}

/**
 * A rolling or unbounded window of frame timings.
 *
 * `limit` bounds it, which is what the live readout wants (the last couple of
 * seconds); the sweep leaves it unbounded so a whole sample period is one
 * population. Deltas rather than absolute times, so a paused tab that resumes
 * mid-window shows up as one huge frame instead of skewing an average.
 */
export class FrameSampler {
  readonly #limit: number;

  #wall: number[] = [];

  #cpu: number[] = [];

  #tick: number[] = [];

  #gpu: number[] = [];

  #heap: number[] = [];

  #last: number | undefined;

  #epoch = 0;

  constructor(limit = 0) {
    this.#limit = limit;
  }

  /**
   * A GPU timing, whenever its query finally resolves. Kept apart from `push`
   * because the two are not in step: a result lands frames after the frame it
   * belongs to, so pairing them would mean holding frames open for a number
   * that may never arrive.
   */
  pushGpu(ms: number): void {
    this.#gpu.push(ms);
    if (this.#limit > 0 && this.#gpu.length > this.#limit) {
      this.#gpu.shift();
    }
  }

  /**
   * The heap for this frame, in MB. Its own population like `pushGpu`, since it
   * is absent entirely on browsers that do not offer the reading and a frame
   * without one is still a frame.
   */
  pushHeap(mb: number): void {
    this.#heap.push(mb);
    if (this.#limit > 0 && this.#heap.length > this.#limit) {
      this.#heap.shift();
    }
  }

  /**
   * `now` is a monotonic timestamp, `cpuMs` the render duration for that frame,
   * and `tickMs` the clock tick that preceded it.
   */
  push(now: number, cpuMs?: number, tickMs?: number): void {
    const previous = this.#last;
    this.#last = now;
    if (previous === undefined) {
      // The first push only establishes the origin — there is no delta yet.
      return;
    }
    this.#wall.push(now - previous);
    if (cpuMs !== undefined) {
      this.#cpu.push(cpuMs);
    }
    if (tickMs !== undefined) {
      this.#tick.push(tickMs);
    }
    if (this.#limit > 0 && this.#wall.length > this.#limit) {
      this.#wall.shift();
      this.#cpu.shift();
      this.#tick.shift();
    }
  }

  /**
   * Drop what has been collected but keep the origin, so the next frame yields
   * a delta instead of being swallowed. This is how a warmup period is
   * discarded without losing a frame at the seam.
   */
  reset(): void {
    this.#wall = [];
    this.#cpu = [];
    this.#tick = [];
    this.#gpu = [];
    this.#heap = [];
    this.#epoch += 1;
  }

  /**
   * Bumped by every `reset`, so a reading that was started before the reset can
   * tell that it no longer belongs here.
   *
   * The GPU clock needs it: its results arrive some frames after the frame they
   * measure, so a query issued during the warmup resolves after the warmup has
   * been thrown away. Pushing it anyway put shader compiles and buffer uploads —
   * the very frames the warmup exists to discard — into the sampled population.
   */
  get epoch(): number {
    return this.#epoch;
  }

  get frames(): number {
    return this.#wall.length;
  }

  snapshot(): FrameSample {
    const wall = seriesStats(this.#wall);
    const elapsedMs = this.#wall.reduce((total, value) => total + value, 0);
    const jankFrames = this.#wall.filter((value) => value > JANK_MS).length;
    return {
      frames: this.#wall.length,
      elapsedMs,
      fps: elapsedMs > 0 ? (this.#wall.length / elapsedMs) * 1000 : 0,
      wall,
      cpu: seriesStats(this.#cpu),
      tick: seriesStats(this.#tick),
      gpu: seriesStats(this.#gpu),
      heap: seriesStats(this.#heap),
      jankFrames,
      jankRatio: this.#wall.length > 0 ? jankFrames / this.#wall.length : 0,
    };
  }
}

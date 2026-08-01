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
   */
  cpu: SeriesStats | undefined;
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

  #last: number | undefined;

  constructor(limit = 0) {
    this.#limit = limit;
  }

  /** `now` is a monotonic timestamp; `cpuMs` the render duration for that frame. */
  push(now: number, cpuMs?: number): void {
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
    if (this.#limit > 0 && this.#wall.length > this.#limit) {
      this.#wall.shift();
      this.#cpu.shift();
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
      jankFrames,
      jankRatio: this.#wall.length > 0 ? jankFrames / this.#wall.length : 0,
    };
  }
}

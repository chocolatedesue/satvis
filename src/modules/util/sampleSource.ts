// Where a trajectory's samples come from.
//
// One interface, two implementations, chosen once: a worker for the app and an
// inline one for tests and for any environment without workers. That is the whole
// reason this file exists — the alternative was a fallback branch inside
// SampledTrajectory, which meant every sample carrying a question about where it
// came from.
//
// The worker implementation batches: a synchronous burst of requests from the
// build queue is coalesced onto one message by a microtask, so sixty-four
// satellites cost one round trip rather than sixty-four, without costing a frame.
//
// It is also a small pool rather than one worker, because the build drains at the
// speed of SGP4 and one thread of it is the ceiling. Which worker a satellite
// belongs to is a pure function of its satnum and never changes — see `#laneFor`,
// where the reasons that has to be true are the interesting part.

import type { GpRecord } from "./gp";
import { runCommand, SatrecCache, type Sgp4Chunk, type Sgp4Command, type Sgp4Request, type Sgp4Response } from "./sgp4Worker";

/** Samples for one interval. See Sgp4Chunk for what the fields mean. */
export type SampleChunk = Sgp4Chunk;

/**
 * A satellite's sampling, bound to its satnum and element set.
 *
 * Bound so that `SampledTrajectory` never handles a satnum, a record or a
 * transport — it asks for an interval and gets samples.
 */
export interface TrajectorySampler {
  samples(fromEpochMs: number, toEpochMs: number): Promise<SampleChunk | undefined>;
}

export interface SampleSource {
  samplerFor(satnum: string, record: GpRecord): TrajectorySampler;
  /** Counters, so a measurement can tell whether this is earning its keep. */
  readonly stats: SampleSourceStats;
}

export interface SampleSourceStats {
  requests: number;
  chunks: number;
  samples: number;
  refused: number;
  unopenable: number;
  /** Requests answered by the inline implementation after the worker was given up on. */
  inlineFallbacks: number;
}

/**
 * How long the worker may go *silent* before it is presumed dead.
 *
 * Silence, not batch age. A large activation posts every batch in one turn and the
 * worker answers them in order, so the last batch of five thousand satellites is
 * legitimately unanswered for seconds while the ones ahead of it propagate — timing
 * from when a batch was posted made that look like a hung worker on any machine
 * slower than the one it was tuned on. Giving up is expensive and permanent: it
 * terminates the worker and re-runs every pending window inline, synchronously, on
 * the thread the worker exists to protect. So the clock now restarts on every
 * reply, and only a worker that has said nothing at all for this long is dead.
 */
const WORKER_SILENCE_MS = 4000;

/**
 * Commands per message.
 *
 * A cap, not a target: coalescing is worth doing but one message is not. A single
 * `postMessage` carrying every request in an activation means structured-cloning
 * five thousand element sets in one go on this thread — measured at a 133 ms frame
 * — and the worker cannot start on any of it until all of it has been
 * deserialised. Splitting pipelines the two sides against each other: the worker
 * is propagating batch one while this thread is still posting batch ten, and the
 * build starts consuming before the tail has been asked for.
 */
const MAX_COMMANDS_PER_MESSAGE = 64;

const emptyStats = (): SampleSourceStats => ({ requests: 0, chunks: 0, samples: 0, refused: 0, unopenable: 0, inlineFallbacks: 0 });

/**
 * Propagates on the calling thread. The tests' implementation, and what the
 * worker-backed one degrades into.
 */
export class InlineSampleSource implements SampleSource {
  readonly #cache = new SatrecCache();

  readonly stats = emptyStats();

  samplerFor(satnum: string, record: GpRecord): TrajectorySampler {
    return {
      samples: (fromEpochMs, toEpochMs) => {
        this.stats.requests += 1;
        const reply = runCommand(this.#cache, { kind: "sample", satnum, fromEpochMs, toEpochMs, record });
        if (reply.kind !== "chunk") {
          if (reply.kind === "unopenable") this.stats.unopenable += 1;
          return Promise.resolve(undefined);
        }
        this.stats.chunks += 1;
        this.stats.samples += reply.chunk.positionsFixed.length / 3;
        this.stats.refused += reply.chunk.refusedIndices.length;
        return Promise.resolve(reply.chunk);
      },
    };
  }
}

/**
 * One outstanding request. The record is kept whether or not it goes on the wire,
 * so an `unknown` reply can be retried with it.
 */
interface Pending {
  resolve: (chunk: SampleChunk | undefined) => void;
  satnum: string;
  fromEpochMs: number;
  toEpochMs: number;
  record: GpRecord;
  sendRecord: boolean;
}

/** One worker and the traffic bound for it. See `#laneFor`. */
interface WorkerLane {
  worker: Worker;
  queued: Pending[];
  /** In-flight batches, so replies can be correlated. */
  inFlight: Map<number, Pending[]>;
  /** Restarted by every reply from this worker. See WORKER_SILENCE_MS. */
  silenceTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Ceiling on the pool.
 *
 * The build is worker-bound, measured rather than assumed: at 5,000 satellites a
 * 4.8x cheaper main-thread ingest moved `buildMs` by 19%, and then moving 48 ms of
 * rotation *into* the worker moved it back by 47. The queue drains at the speed of
 * SGP4, which is what a pool splits.
 *
 * Bounded rather than greedy, because two things already want the cores this would
 * take: the main thread, which is building entities and rendering throughout, and
 * the pass predictor's own worker.
 *
 * **This stops paying somewhere between 5,000 satellites and 10,000.** `buildMs`
 * medians against no pool: 27 → 19 at 100, 131 → 60 at 1,000, 562 → 321 at 5,000,
 * and 1,508 → 993 at 10,000 — where the propagation phases alone reach 934. Past
 * about five thousand the build stops waiting on SGP4 and starts waiting on entity
 * creation against the per-frame budget, and no amount of propagation throughput
 * moves a main-thread bound. Don't read the 5,000 figure as a slope.
 *
 * **It is also worth nothing without the worker-side rotation, and the reverse.**
 * That rotation (see sgp4Worker) measured as an 11% *regression* on its own, by
 * lengthening the worker's critical path. But with the rotation left on the main
 * thread, a pool is worse than no pool at all at 10,000 — 1,295 ms against 988 —
 * because four workers then feed the main thread faster than it can ingest. The
 * pair is the unit; neither half is worth judging alone.
 *
 * Four rather than two, measured over two interleaved passes: 4 is better on every
 * frame-time column at 5,000 and 10,000 and 17% better on `buildMs` at 1,000, and
 * 2 wins only `buildMs` at 10,000 by 9%. An earlier reading that 4 hurt tail
 * latency did not survive replication.
 */
const MAX_WORKERS = 4;

/**
 * Which lane a satnum belongs to. Exported for its test rather than for callers:
 * the property worth pinning is that it is a pure function, and that is not
 * observable from outside a pool whose workers the test environment has no way to
 * start.
 *
 * FNV-1a rather than `Number(satnum) % laneCount`: satnums are usually numeric but
 * nothing guarantees it, and a hash that only works on digits would quietly pile
 * every non-numeric satellite onto one worker.
 */
export function laneIndexFor(satnum: string, laneCount: number): number {
  if (laneCount <= 1) {
    return 0;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < satnum.length; index += 1) {
    hash ^= satnum.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % laneCount;
}

function poolSize(): number {
  const cores = typeof navigator === "object" && navigator ? (navigator.hardwareConcurrency ?? 0) : 0;
  if (!Number.isFinite(cores) || cores <= 0) {
    // Unknown concurrency is answered with the old behaviour rather than a guess.
    return 1;
  }
  return Math.max(1, Math.min(MAX_WORKERS, cores - 2));
}

export class WorkerSampleSource implements SampleSource {
  #lanes: WorkerLane[] = [];

  /** Set once the pool is given up on; every request goes inline from then on. */
  #inline: InlineSampleSource | undefined;

  /** Unique across lanes, so a reply is found in its own lane's map and nowhere else. */
  #nextBatchId = 1;

  #flushScheduled = false;

  /** Satnums whose record has been sent at least once. See `record` in Sgp4SampleCommand. */
  #recordSent = new Set<string>();

  readonly stats = emptyStats();

  constructor() {
    if (typeof Worker !== "function") {
      this.#giveUp("this environment has no Worker");
      return;
    }
    try {
      for (let index = 0; index < poolSize(); index += 1) {
        const lane: WorkerLane = {
          worker: new Worker(new URL("./sgp4Worker.ts", import.meta.url), { type: "module" }),
          queued: [],
          inFlight: new Map(),
          silenceTimer: undefined,
        };
        lane.worker.addEventListener("message", (event: MessageEvent<Sgp4Response>) => this.#accept(lane, event.data));
        lane.worker.addEventListener("error", (event) => this.#giveUp(event.message || "worker error"));
        this.#lanes.push(lane);
      }
    } catch (error) {
      this.#giveUp(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Which worker owns a satellite. A pure function of the satnum, and that is
   * load-bearing in three separate places rather than a tidiness preference:
   *
   * - **The satrec cache is per worker.** Scattering one satellite's requests
   *   across the pool would build a satrec for it in every worker it touched —
   *   `sgp4init` and its memory multiplied by the pool size, for one satellite.
   * - **`#recordSent` is one set for the whole pool.** It records that *a* worker
   *   has the element set, which is only the same statement as *the* worker having
   *   it while the mapping holds. Round-robin would answer the first request to
   *   each new worker with `unknown` and pay a round trip to learn it.
   * - **Eviction stays meaningful.** MAX_CACHED_SATRECS bounds a worker's own
   *   satellites rather than a shifting fraction of all of them.
   */
  #laneFor(satnum: string): WorkerLane | undefined {
    return this.#lanes[laneIndexFor(satnum, this.#lanes.length)];
  }

  samplerFor(satnum: string, record: GpRecord): TrajectorySampler {
    return {
      samples: (fromEpochMs, toEpochMs) => {
        this.stats.requests += 1;
        if (this.#inline) {
          return this.#inlineSamples(satnum, record, fromEpochMs, toEpochMs);
        }
        const lane = this.#laneFor(satnum);
        if (!lane) {
          // Not reachable while the pool is up, since every satnum maps to a lane.
          // A pool that emptied without giving up would otherwise drop the request
          // on the floor and leave the caller waiting on a promise nothing settles.
          this.#giveUp("no propagation worker");
          return this.#inlineSamples(satnum, record, fromEpochMs, toEpochMs);
        }
        // The record only goes on the wire when this satellite's worker cannot be
        // assumed to hold a satrec for it yet.
        const sendRecord = !this.#recordSent.has(satnum);
        this.#recordSent.add(satnum);
        return new Promise<SampleChunk | undefined>((resolve) => {
          lane.queued.push({ resolve, satnum, fromEpochMs, toEpochMs, record, sendRecord });
          this.#schedule();
        });
      },
    };
  }

  /** Every path that has stopped using the pool funnels through here. */
  #inlineSamples(satnum: string, record: GpRecord, fromEpochMs: number, toEpochMs: number): Promise<SampleChunk | undefined> {
    const inline = this.#inline;
    if (!inline) {
      return Promise.resolve(undefined);
    }
    this.stats.inlineFallbacks += 1;
    return inline.samplerFor(satnum, record).samples(fromEpochMs, toEpochMs);
  }

  /**
   * Coalesce onto one message per turn. A microtask rather than a frame: the build
   * queue asks for a whole chunk of satellites synchronously, and making it wait
   * for a frame would put latency back that the batching is meant to remove.
   */
  #schedule(): void {
    if (this.#flushScheduled) {
      return;
    }
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    for (const lane of this.#lanes) {
      const queued = lane.queued;
      if (queued.length === 0) {
        continue;
      }
      lane.queued = [];
      for (let offset = 0; offset < queued.length; offset += MAX_COMMANDS_PER_MESSAGE) {
        const pending = queued.slice(offset, offset + MAX_COMMANDS_PER_MESSAGE);
        const batchId = this.#nextBatchId++;
        const commands: Sgp4Command[] = pending.map((item) =>
          item.sendRecord
            ? { kind: "sample", satnum: item.satnum, fromEpochMs: item.fromEpochMs, toEpochMs: item.toEpochMs, record: item.record }
            : { kind: "sample", satnum: item.satnum, fromEpochMs: item.fromEpochMs, toEpochMs: item.toEpochMs },
        );
        const request: Sgp4Request = { batchId, commands };
        lane.inFlight.set(batchId, pending);
        // Not `Window.postMessage`, which is the one that takes a target origin. A
        // worker's second parameter is a transfer list, and the fix this rule
        // suggests throws: `postMessage(msg, self.location.origin)` fails overload
        // resolution in Chrome. Verified rather than assumed.
        // eslint-disable-next-line unicorn/require-post-message-target-origin
        lane.worker.postMessage(request);
      }
      this.#armSilenceTimer(lane);
    }
  }

  /**
   * Restart one lane's silence timer while it has anything outstanding.
   *
   * Per lane, because an idle worker is legitimately silent: with one timer for the
   * pool, a lane holding no work would be indistinguishable from a lane that had
   * died, and the whole pool would be torn down on the first quiet stretch.
   */
  #armSilenceTimer(lane: WorkerLane): void {
    if (lane.silenceTimer !== undefined) {
      clearTimeout(lane.silenceTimer);
      lane.silenceTimer = undefined;
    }
    if (lane.inFlight.size === 0 || this.#inline) {
      return;
    }
    lane.silenceTimer = setTimeout(() => this.#giveUp(`a worker said nothing for ${WORKER_SILENCE_MS} ms`), WORKER_SILENCE_MS);
  }

  #accept(lane: WorkerLane, response: Sgp4Response): void {
    const batch = lane.inFlight.get(response.batchId);
    if (!batch) {
      return;
    }
    lane.inFlight.delete(response.batchId);
    // Proof of life, so the timer measures silence rather than the depth of the
    // queue this reply just came off.
    this.#armSilenceTimer(lane);
    response.replies.forEach((reply, index) => {
      const pending = batch[index];
      if (!pending) {
        return;
      }
      if (reply.kind === "chunk") {
        this.stats.chunks += 1;
        this.stats.samples += reply.chunk.positionsFixed.length / 3;
        this.stats.refused += reply.chunk.refusedIndices.length;
        pending.resolve(reply.chunk);
        return;
      }
      if (reply.kind === "unknown") {
        // The satrec was evicted, or a batch raced ahead of the one that would
        // have created it. Re-queue with the record attached this time — onto this
        // same lane, which is where the mapping sends it anyway.
        this.#recordSent.delete(reply.satnum);
        lane.queued.push({ ...pending, sendRecord: true });
        this.#schedule();
        return;
      }
      this.stats.unopenable += 1;
      pending.resolve(undefined);
    });
  }

  /**
   * Stop using the pool and answer everything inline from here on.
   *
   * Loud, and once: a worker that fails to construct, throws on load or simply
   * stops answering would otherwise look like nothing more than a slow build, and
   * the app would keep working while quietly propagating everything on the thread
   * this exists to protect.
   *
   * All of them rather than the one that failed. A lane owns its satellites
   * outright, so keeping the survivors would leave part of the catalog propagating
   * off-thread and part of it inline, at different speeds, with the failure
   * reported once and then invisible. One rule is easier to reason about than a
   * pool that is partly alive, and the fallback is correct either way.
   */
  #giveUp(reason: string): void {
    if (this.#inline) {
      return;
    }
    console.error(`SGP4 worker unavailable (${reason}); propagating on the main thread instead`);
    this.#inline = new InlineSampleSource();
    const lanes = this.#lanes;
    this.#lanes = [];
    for (const lane of lanes) {
      lane.worker.terminate();
      if (lane.silenceTimer !== undefined) {
        clearTimeout(lane.silenceTimer);
        lane.silenceTimer = undefined;
      }
      for (const pending of lane.inFlight.values()) {
        for (const item of pending) {
          this.#retryInline(item);
        }
      }
      lane.inFlight.clear();
      const queued = lane.queued;
      lane.queued = [];
      for (const item of queued) {
        this.#retryInline(item);
      }
    }
  }

  #retryInline(item: Pending): void {
    const inline = this.#inline;
    if (!inline) {
      item.resolve(undefined);
      return;
    }
    this.stats.inlineFallbacks += 1;
    void inline.samplerFor(item.satnum, item.record).samples(item.fromEpochMs, item.toEpochMs).then(item.resolve);
  }
}

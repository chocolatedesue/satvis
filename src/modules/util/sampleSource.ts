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
        this.stats.samples += reply.chunk.teme.length / 3;
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

export class WorkerSampleSource implements SampleSource {
  #worker: Worker | undefined;

  /** Set once the worker is given up on; every request goes inline from then on. */
  #inline: InlineSampleSource | undefined;

  #nextBatchId = 1;

  #queued: Pending[] = [];

  #flushScheduled = false;

  /** In-flight batches, so replies can be correlated. */
  #inFlight = new Map<number, Pending[]>();

  /** One timer for the whole worker, restarted by every reply. See WORKER_SILENCE_MS. */
  #silenceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Satnums whose record has been sent at least once. See `record` in Sgp4SampleCommand. */
  #recordSent = new Set<string>();

  readonly stats = emptyStats();

  constructor() {
    if (typeof Worker !== "function") {
      this.#giveUp("this environment has no Worker");
      return;
    }
    try {
      this.#worker = new Worker(new URL("./sgp4Worker.ts", import.meta.url), { type: "module" });
      this.#worker.addEventListener("message", (event: MessageEvent<Sgp4Response>) => this.#accept(event.data));
      this.#worker.addEventListener("error", (event) => this.#giveUp(event.message || "worker error"));
    } catch (error) {
      this.#giveUp(error instanceof Error ? error.message : String(error));
    }
  }

  samplerFor(satnum: string, record: GpRecord): TrajectorySampler {
    return {
      samples: (fromEpochMs, toEpochMs) => {
        this.stats.requests += 1;
        if (this.#inline) {
          this.stats.inlineFallbacks += 1;
          return this.#inline.samplerFor(satnum, record).samples(fromEpochMs, toEpochMs);
        }
        // The record only goes on the wire when the worker cannot be assumed to
        // hold a satrec for this satellite yet.
        const sendRecord = !this.#recordSent.has(satnum);
        this.#recordSent.add(satnum);
        return new Promise<SampleChunk | undefined>((resolve) => {
          this.#queued.push({ resolve, satnum, fromEpochMs, toEpochMs, record, sendRecord });
          this.#schedule();
        });
      },
    };
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
    const queued = this.#queued;
    this.#queued = [];
    if (queued.length === 0 || !this.#worker) {
      return;
    }
    for (let offset = 0; offset < queued.length; offset += MAX_COMMANDS_PER_MESSAGE) {
      const pending = queued.slice(offset, offset + MAX_COMMANDS_PER_MESSAGE);
      const batchId = this.#nextBatchId++;
      const commands: Sgp4Command[] = pending.map((item) =>
        item.sendRecord
          ? { kind: "sample", satnum: item.satnum, fromEpochMs: item.fromEpochMs, toEpochMs: item.toEpochMs, record: item.record }
          : { kind: "sample", satnum: item.satnum, fromEpochMs: item.fromEpochMs, toEpochMs: item.toEpochMs },
      );
      const request: Sgp4Request = { batchId, commands };
      this.#inFlight.set(batchId, pending);
      // Not `Window.postMessage`, which is the one that takes a target origin. A
      // worker's second parameter is a transfer list, and the fix this rule
      // suggests throws: `postMessage(msg, self.location.origin)` fails overload
      // resolution in Chrome. Verified rather than assumed.
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      this.#worker.postMessage(request);
    }
    this.#armSilenceTimer();
  }

  /** Restart the silence timer while anything is outstanding, and stop it when nothing is. */
  #armSilenceTimer(): void {
    if (this.#silenceTimer !== undefined) {
      clearTimeout(this.#silenceTimer);
      this.#silenceTimer = undefined;
    }
    if (this.#inFlight.size === 0 || !this.#worker) {
      return;
    }
    this.#silenceTimer = setTimeout(() => this.#giveUp(`worker said nothing for ${WORKER_SILENCE_MS} ms`), WORKER_SILENCE_MS);
  }

  #accept(response: Sgp4Response): void {
    const batch = this.#inFlight.get(response.batchId);
    if (!batch) {
      return;
    }
    this.#inFlight.delete(response.batchId);
    // Proof of life, so the timer measures silence rather than the depth of the
    // queue this reply just came off.
    this.#armSilenceTimer();
    response.replies.forEach((reply, index) => {
      const pending = batch[index];
      if (!pending) {
        return;
      }
      if (reply.kind === "chunk") {
        this.stats.chunks += 1;
        this.stats.samples += reply.chunk.teme.length / 3;
        this.stats.refused += reply.chunk.refusedIndices.length;
        pending.resolve(reply.chunk);
        return;
      }
      if (reply.kind === "unknown") {
        // The satrec was evicted, or a batch raced ahead of the one that would
        // have created it. Re-queue with the record attached this time.
        this.#recordSent.delete(reply.satnum);
        this.#queued.push({ ...pending, sendRecord: true });
        this.#schedule();
        return;
      }
      this.stats.unopenable += 1;
      pending.resolve(undefined);
    });
  }

  /**
   * Stop using the worker and answer everything inline from here on.
   *
   * Loud, and once: a worker that fails to construct, throws on load or simply
   * stops answering would otherwise look like nothing more than a slow build, and
   * the app would keep working while quietly propagating everything on the thread
   * this exists to protect.
   */
  #giveUp(reason: string): void {
    if (this.#inline) {
      return;
    }
    console.error(`SGP4 worker unavailable (${reason}); propagating on the main thread instead`);
    this.#inline = new InlineSampleSource();
    this.#worker?.terminate();
    this.#worker = undefined;
    if (this.#silenceTimer !== undefined) {
      clearTimeout(this.#silenceTimer);
      this.#silenceTimer = undefined;
    }
    for (const pending of this.#inFlight.values()) {
      for (const item of pending) {
        this.#retryInline(item);
      }
    }
    this.#inFlight.clear();
    const queued = this.#queued;
    this.#queued = [];
    for (const item of queued) {
      this.#retryInline(item);
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

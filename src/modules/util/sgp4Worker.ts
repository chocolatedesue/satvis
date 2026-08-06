// SGP4 propagation, off the main thread.
//
// Cesium-free on purpose: satellite.js, the GP record helpers and the fixed-frame
// rotation, nothing else.
//
// Only one of the two frame transforms needs Cesium. Fixed to ICRF does — it rests
// on IAU data loaded asynchronously — and it stays on the main thread, charged to
// the trajectories that draw an orbit. TEME to pseudo-fixed does not: it is a
// rotation about Z by the Greenwich hour angle, arithmetic and nothing more (see
// temeToFixed). Doing it here means the reply carries positions the grid stores
// as they arrive, so the main thread's share of a sample is a typed-array copy.
//
// Two properties are worth stating up front, because the rest of the design
// follows from them.
//
// **A request names an interval, and the answer is a pure function of it.** No
// cursor, no memory of what has already been sent, so a request is idempotent: a
// duplicated reply is harmless, a dropped one costs a retry, and a clock scrubbed
// backwards is just a different interval rather than a special case. The only
// state is a satrec cache, and that is a memo — losing it costs one `sgp4init`.
//
// **Sample times sit on a grid anchored to the element set's own epoch.** Not on
// the first request, which would be state, and not on the requested interval,
// which would shift the grid every time. `t_i = epoch + i·step` is fixed for the
// life of an element set, so samples from consecutive requests interleave evenly
// without either side tracking the other. That is what lets the caller ask for
// approximate bounds: a window a few seconds wider or narrower does not matter,
// where samples landing a few seconds off their expected times would.

import * as satellitejs from "satellite.js";

import { createSatrec, type GpRecord } from "./gp";
import { fixedRotationAt, type FixedRotation } from "./temeToFixed";
import { SAMPLES_PER_ORBIT } from "./trajectoryWindow";

/** Julian date of the Unix epoch, for turning a satrec's epoch into milliseconds. */
const JD_UNIX_EPOCH = 2440587.5;

const MS_PER_DAY = 86_400_000;

/**
 * Ask for every grid sample inside `[fromEpochMs, toEpochMs]`.
 *
 * `record` is only needed when the worker holds no satrec for `satnum` — the
 * first request for a satellite, or a retry after an `unknown` reply. Sending it
 * every time would structured-clone an OMM object per request, which at ×1000 and
 * five thousand satellites is thousands a second for data already held.
 */
export interface Sgp4SampleCommand {
  kind: "sample";
  satnum: string;
  fromEpochMs: number;
  toEpochMs: number;
  record?: GpRecord;
}

export type Sgp4Command = Sgp4SampleCommand;

export interface Sgp4Request {
  batchId: number;
  commands: Sgp4Command[];
}

export interface Sgp4Chunk {
  satnum: string;
  /**
   * The grid's origin, and the index of this chunk's first sample within it.
   *
   * The consumer derives sample times as `anchor + (firstIndex + i) · step` rather
   * than from a per-chunk start, and that is load-bearing: a start is a float, the
   * only way to carry it into a Cesium `JulianDate` is through `Date`, and `Date`
   * holds whole milliseconds. Two chunks rounding their own starts would disagree
   * by under a millisecond about the *same* grid instant, which a sampled position
   * property reads as two distinct samples — a duplicate a fraction of a
   * millisecond apart. Measured before this was carried explicitly: a pair of
   * samples with zero displacement between them, and a seam 112 s wide.
   *
   * The anchor is one value for the life of an element set, so every chunk agrees
   * on it exactly and identical indices produce identical times.
   */
  anchorEpochMs: number;
  firstIndex: number;
  /** Epoch milliseconds of the first sample. Convenience; not used for placement. */
  startEpochMs: number;
  stepSeconds: number;
  /**
   * Earth-fixed positions in **metres**, three doubles per sample.
   *
   * Already rotated out of TEME and already in metres rather than the kilometres
   * satellite.js returns, so the main thread does no per-sample arithmetic on the
   * way in — for a satellite with no sampled property this buffer goes straight
   * into the grid. The frame is Cesium's *pseudo*-fixed: `computeTemeToPseudoFixedMatrix`
   * reproduced exactly, not `eciToEcf`, which uses a different GMST formulation.
   */
  positionsFixed: Float64Array;
  /**
   * Sample indices in this chunk that have no position, because the propagator
   * refused them — a decayed orbit, a deep-space case that diverges, a time far
   * from the element set's epoch. Their triples are left at zero.
   *
   * The consumer's job is to **skip** them, not to retry them: a retry would run
   * the same propagator on the same satrec at the same instant and fail
   * identically. A sampled position property interpolates across the gap, so one
   * missing instant out of a couple of hundred is invisible.
   */
  refusedIndices: number[];
}

export type Sgp4Reply =
  | { kind: "chunk"; chunk: Sgp4Chunk }
  /** No satrec held for this satellite. Retry with `record` attached. */
  | { kind: "unknown"; satnum: string }
  /** The element set cannot be propagated at all; no retry will help. */
  | { kind: "unopenable"; satnum: string; reason: string };

export interface Sgp4Response {
  batchId: number;
  replies: Sgp4Reply[];
}

/** Where this element set's grid is anchored, in epoch milliseconds. */
export function gridAnchorEpochMs(satrec: satellitejs.SatRec): number {
  // satellite.js splits the epoch across a whole and a fractional field on some
  // versions; treating a missing fraction as zero is right either way.
  const fractional = (satrec as unknown as { jdsatepochF?: number }).jdsatepochF ?? 0;
  return (satrec.jdsatepoch + fractional - JD_UNIX_EPOCH) * MS_PER_DAY;
}

/** Seconds between samples: one revolution over the sampling rate. */
export function gridStepSeconds(satrec: satellitejs.SatRec): number {
  const meanMotionRad = satrec.no;
  if (!Number.isFinite(meanMotionRad) || meanMotionRad <= 0) {
    return 0;
  }
  const orbitalPeriodMinutes = (2 * Math.PI) / meanMotionRad;
  return (orbitalPeriodMinutes * 60) / SAMPLES_PER_ORBIT;
}

/**
 * Every grid sample inside the interval, propagated. Undefined when the element
 * set yields no usable grid at all.
 *
 * Pure, exported, and the only thing here that computes anything — so the whole
 * behaviour is testable without a worker, which is also how the no-worker
 * implementation on the main thread is built.
 */
export function sampleInterval(satrec: satellitejs.SatRec, satnum: string, fromEpochMs: number, toEpochMs: number): Sgp4Chunk | undefined {
  const stepSeconds = gridStepSeconds(satrec);
  const anchor = gridAnchorEpochMs(satrec);
  if (stepSeconds <= 0 || !Number.isFinite(anchor)) {
    return undefined;
  }
  const stepMs = stepSeconds * 1000;
  const firstIndex = Math.ceil((fromEpochMs - anchor) / stepMs);
  const lastIndex = Math.floor((toEpochMs - anchor) / stepMs);
  const sampleCount = lastIndex - firstIndex + 1;
  const startEpochMs = anchor + firstIndex * stepMs;
  if (sampleCount <= 0) {
    // An interval narrower than one step falls between grid points. Legitimate,
    // and answered with nothing rather than with an off-grid sample.
    return { satnum, anchorEpochMs: anchor, firstIndex, startEpochMs, stepSeconds, positionsFixed: new Float64Array(0), refusedIndices: [] };
  }

  // Truncated, because that is where the consumer files these samples. The anchor
  // reaches a Cesium JulianDate only through `Date`, which holds whole
  // milliseconds, so sample i sits at `trunc(anchor) + i·step` however precise the
  // anchor itself is. Rotating at the untruncated instant instead leaves the frame
  // up to a millisecond of Earth rotation out of step with the time the sample is
  // filed under — 4.3 cm, and silent.
  const rotationAnchorMs = Math.trunc(anchor);
  const rotation: FixedRotation = { cos: 1, sin: 0 };
  const positionsFixed = new Float64Array(sampleCount * 3);
  const refusedIndices: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const propagated = satellitejs.propagate(satrec, new Date(startEpochMs + index * stepMs));
    const position = propagated?.position;
    if (satrec.error || !position || typeof position === "boolean") {
      refusedIndices.push(index);
      continue;
    }
    const x = position.x * 1000;
    const y = position.y * 1000;
    fixedRotationAt(rotationAnchorMs + (firstIndex + index) * stepMs, rotation);
    positionsFixed[index * 3] = rotation.cos * x + rotation.sin * y;
    positionsFixed[index * 3 + 1] = rotation.cos * y - rotation.sin * x;
    positionsFixed[index * 3 + 2] = position.z * 1000;
  }
  return { satnum, anchorEpochMs: anchor, firstIndex, startEpochMs, stepSeconds, positionsFixed, refusedIndices };
}

/**
 * How many satrecs to memoise. A cache, not a registry: an eviction is a miss and
 * a miss is one `sgp4init`, so nothing has to tell the worker when a satellite
 * goes away and there is no lifecycle here to leak.
 *
 * Per worker, so a pool of four raises the nominal ceiling to eighty thousand.
 * That is looser than it looks: a satellite belongs to exactly one worker for the
 * session (see `#laneFor` in sampleSource), so what is actually resident across
 * the pool is bounded by the catalog — some sixteen thousand — not by this times
 * the pool size.
 */
const MAX_CACHED_SATRECS = 20_000;

/**
 * Satrecs by satnum.
 *
 * Satnum rather than the catalog key, because what is cached is the *propagator*
 * and not the subscriber. Two catalog entries can share a satnum, and measured on
 * the live catalog the two that do have byte-identical element sets — the same
 * satellite listed twice under different names — so sharing one satrec between
 * them is correct rather than merely tolerable. Which trajectory a reply belongs
 * to is the main thread's business, keyed there by the composite catalog key as
 * everywhere else.
 */
export class SatrecCache {
  #bySatnum = new Map<string, satellitejs.SatRec>();

  get(satnum: string): satellitejs.SatRec | undefined {
    return this.#bySatnum.get(satnum);
  }

  set(satnum: string, satrec: satellitejs.SatRec): void {
    if (this.#bySatnum.size >= MAX_CACHED_SATRECS) {
      // Insertion order, so this drops the least recently added. Good enough for
      // a memo whose miss costs microseconds.
      const oldest = this.#bySatnum.keys().next().value;
      if (oldest !== undefined) {
        this.#bySatnum.delete(oldest);
      }
    }
    this.#bySatnum.set(satnum, satrec);
  }

  get size(): number {
    return this.#bySatnum.size;
  }
}

/** Answer one command against a cache. Shared by the worker and the inline source. */
export function runCommand(cache: SatrecCache, command: Sgp4Command): Sgp4Reply {
  let satrec = cache.get(command.satnum);
  if (!satrec) {
    if (!command.record) {
      return { kind: "unknown", satnum: command.satnum };
    }
    try {
      satrec = createSatrec(command.record);
    } catch (error) {
      return { kind: "unopenable", satnum: command.satnum, reason: error instanceof Error ? error.message : String(error) };
    }
    cache.set(command.satnum, satrec);
  }
  const chunk = sampleInterval(satrec, command.satnum, command.fromEpochMs, command.toEpochMs);
  return chunk ? { kind: "chunk", chunk } : { kind: "unopenable", satnum: command.satnum, reason: "no usable mean motion" };
}

// Guarded on the absence of `window` rather than on `self` existing: on the main
// thread `self` *is* the window, so a looser check would install this listener on
// the page whenever the module is imported for its pure functions — as the unit
// tests and the inline source both do.
const inWorkerScope = typeof (globalThis as { window?: unknown }).window === "undefined" && typeof (globalThis as { postMessage?: unknown }).postMessage === "function";

if (inWorkerScope) {
  const cache = new SatrecCache();
  self.addEventListener("message", (event: MessageEvent<Sgp4Request>) => {
    const { batchId, commands } = event.data;
    const replies = commands.map((command) => runCommand(cache, command));
    const response: Sgp4Response = { batchId, replies };
    // Transferred, not copied.
    const buffers = replies.filter((reply): reply is { kind: "chunk"; chunk: Sgp4Chunk } => reply.kind === "chunk").map((reply) => reply.chunk.positionsFixed.buffer);
    (self as unknown as { postMessage(message: Sgp4Response, transfer: Transferable[]): void }).postMessage(response, buffers);
  });
}

// Pass prediction, off the main thread.
//
// Its own worker rather than a second command on the sampling one, because the
// two workloads want opposite things. Sampling is latency-sensitive: a reply that
// arrives late is a satellite that stops moving. Pass prediction is a long batch
// job — a five-day window stepped a minute at a time is about 8 ms of SGP4 per
// satellite per station, so selecting a ground station with five thousand
// satellites is some 40 s of work. Sharing a worker would put that 40 s in front
// of every sample request, because postMessage is a queue and nothing here can
// preempt itself. Two workers cost one more thread and keep the two apart.
//
// Cesium-free, like the sampling worker and for the same reason — but easier
// here, because `Orbit` already is: the pass loops are satellite.js and
// arithmetic, and every value that crosses back is a number or a string.

import type { SwathExtents } from "../../config/satelliteMetadata";
import Orbit from "../Orbit";
import type { ElevationPass, GroundStationPosition, SwathPass } from "../Orbit";
import type { GpRecord } from "./gp";

/** One pass, as it crosses the wire. `Pass` in PassPredictor is this plus Cesium's imports. */
export type WorkerPass = (ElevationPass | SwathPass) & { groundStationName?: string };

export interface PassStation {
  name: string;
  position: GroundStationPosition;
}

/**
 * Predict every pass over `stations` inside the window.
 *
 * All the stations in one command, because they share the propagation: the loop
 * is per station today, but a satellite is one `sgp4init` and one cache entry
 * either way, and one command per satellite is what makes a reply mean "this
 * satellite is done".
 *
 * `record` is only needed when the worker holds no orbit for `satnum` — the first
 * request, or a retry after an `unknown` reply. See Sgp4SampleCommand for why
 * that matters.
 */
export interface PassCommand {
  kind: "passes";
  satnum: string;
  record?: GpRecord;
  /** "elevation" (line-of-sight) or "swath" (sensor footprint). */
  mode: string;
  stations: PassStation[];
  startEpochMs: number;
  endEpochMs: number;
  /** Read per request rather than cached: a record arriving later changes it. */
  swath: SwathExtents;
}

export type PassReply =
  | { kind: "passes"; satnum: string; passes: WorkerPass[] }
  /** No orbit held for this satellite. Retry with `record` attached. */
  | { kind: "unknown"; satnum: string }
  /** The element set cannot be propagated at all; no retry will help. */
  | { kind: "unopenable"; satnum: string; reason: string };

export interface PassRequest {
  batchId: number;
  commands: PassCommand[];
}

export interface PassResponse {
  batchId: number;
  replies: PassReply[];
}

/**
 * How many orbits to memoise. Same reasoning as the sampling worker's satrec
 * cache: a miss costs one `sgp4init`, so an eviction is free and nothing has to
 * tell this when a satellite goes away.
 */
const MAX_CACHED_ORBITS = 20_000;

/**
 * Orbits by satnum.
 *
 * The name is deliberately not carried. `Orbit` takes one and stamps it onto
 * every pass it produces, but the main thread knows the name of the satellite it
 * asked about and overwrites it there — so this cache stays keyed on satnum
 * alone, which is the same invariant the sampling worker holds, and two catalog
 * entries sharing a satnum share the propagator rather than fighting over it.
 */
export class OrbitCache {
  #bySatnum = new Map<string, Orbit>();

  get(satnum: string): Orbit | undefined {
    return this.#bySatnum.get(satnum);
  }

  set(satnum: string, orbit: Orbit): void {
    if (this.#bySatnum.size >= MAX_CACHED_ORBITS) {
      const oldest = this.#bySatnum.keys().next().value;
      if (oldest !== undefined) {
        this.#bySatnum.delete(oldest);
      }
    }
    this.#bySatnum.set(satnum, orbit);
  }

  get size(): number {
    return this.#bySatnum.size;
  }
}

/** Answer one command against a cache. Shared by the worker and the inline source. */
export function runPassCommand(cache: OrbitCache, command: PassCommand): PassReply {
  let orbit = cache.get(command.satnum);
  if (!orbit) {
    if (!command.record) {
      return { kind: "unknown", satnum: command.satnum };
    }
    try {
      // The empty name is the point — see OrbitCache.
      orbit = new Orbit("", command.record);
    } catch (error) {
      return { kind: "unopenable", satnum: command.satnum, reason: error instanceof Error ? error.message : String(error) };
    }
    cache.set(command.satnum, orbit);
  }

  const start = new Date(command.startEpochMs);
  const end = new Date(command.endEpochMs);
  const passes: WorkerPass[] = [];
  for (const station of command.stations) {
    const found: WorkerPass[] =
      command.mode === "swath" ? orbit.computePassesSwath(station.position, command.swath, start, end) : orbit.computePassesElevation(station.position, start, end);
    for (const pass of found) {
      pass.groundStationName = station.name;
      passes.push(pass);
    }
  }
  passes.sort((a, b) => a.start - b.start);
  return { kind: "passes", satnum: command.satnum, passes };
}

// Guarded on the absence of `window` rather than on `self` existing: on the main
// thread `self` *is* the window, so a looser check would install this listener on
// the page whenever the module is imported for its pure functions — as the unit
// tests and the inline source both do.
const inWorkerScope = typeof (globalThis as { window?: unknown }).window === "undefined" && typeof (globalThis as { postMessage?: unknown }).postMessage === "function";

if (inWorkerScope) {
  const cache = new OrbitCache();
  self.addEventListener("message", (event: MessageEvent<PassRequest>) => {
    const { batchId, commands } = event.data;
    const replies = commands.map((command) => runPassCommand(cache, command));
    const response: PassResponse = { batchId, replies };
    // Inside the worker, so this is DedicatedWorkerGlobalScope.postMessage — again
    // no target origin. See sampleSource.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    (self as unknown as { postMessage(message: PassResponse): void }).postMessage(response);
  });
}

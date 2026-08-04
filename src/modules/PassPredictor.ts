import { JulianDate, TimeInterval, TimeIntervalCollection } from "@cesium/engine";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type { SwathExtents } from "../config/satelliteMetadata";
import type Orbit from "./Orbit";
import type { GroundStationPosition } from "./Orbit";
import type { PassPredictorSource, WorkerPass } from "./util/passSource";

dayjs.extend(utc);

/** Defined off-thread, where the prediction runs, and re-exported here for its callers. */
export type Pass = WorkerPass;

export interface GroundStation {
  name: string;
  position: GroundStationPosition;
}

/** One rendered row of the passes table in the entity info panel. */
export interface PassRow {
  key: string;
  name: string;
  countdown: string;
  startLabel: string;
  endLabel: string;
  /** Max elevation (elevation mode) or min distance (swath mode). */
  primary: string;
  /** Azimuth at apex (elevation mode) or swath width (swath mode). */
  secondary: string;
  /** Pass start in epoch milliseconds, for time jumps on click. */
  startMs: number;
}

interface PassWindow {
  start: JulianDate;
  stop: JulianDate;
  stopPrediction: JulianDate;
}

/**
 * The single owner of pass prediction for one satellite: holds the ground
 * stations, the overpass mode, the window guard that decides when passes are
 * recomputed, the computed pass list, and the Cesium intervals derived from
 * it (used to gate pass-dependent visuals like the ground-station link).
 *
 * Setting `groundStations` or `mode` invalidates the window; the next
 * `passes(time)` call requests a recompute.
 *
 * `passes(time)` stays synchronous and never blocks. The prediction itself runs
 * off-thread — 8 ms of SGP4 per satellite per station, which is 40 s across five
 * thousand satellites and used to be 40 s of frozen page — so a read while a
 * window is stale returns the previous list, or nothing on the first read, and the
 * answer lands a moment later. Callers that need to know when that happens
 * subscribe with `onChanged`; the info panel re-reads once a second anyway.
 */
export class PassPredictor {
  #orbit: Orbit;

  // Per-side swath extents, read lazily per recompute so a satellite whose
  // record arrives later still predicts against its own footprint.
  #swath: () => SwathExtents;

  #groundStations: GroundStation[] = [];

  #mode = "elevation";

  #passes: Pass[] = [];

  #window: PassWindow | undefined;

  /** Where prediction happens. Injected, so nothing here knows about workers. */
  readonly #source: PassPredictorSource;

  /** True while a request is out, so a per-frame read does not queue another. */
  #requesting = false;

  /** The time a read asked about while a request was already out. */
  #pendingTime: JulianDate | undefined;

  /** The request in flight, so a coalesced caller can await the real answer. */
  #inFlight: Promise<void> | undefined;

  /**
   * Bumped by `clear()`. A reply carrying an older generation was computed against
   * ground stations or a mode that have since changed, so it is dropped rather
   * than shown — the request that replaces it is already out.
   */
  #generation = 0;

  #listeners = new Set<() => void>();

  /** Pass time ranges as Cesium intervals, kept in sync with the pass list. */
  passIntervals = new TimeIntervalCollection();

  constructor(orbit: Orbit, swath: () => SwathExtents, source: PassPredictorSource) {
    this.#orbit = orbit;
    this.#swath = swath;
    this.#source = source;
  }

  /**
   * Called whenever the pass list changes. Returns an unsubscribe.
   *
   * A set rather than one callback because two things want it for the same
   * satellite: the timeline highlight ranges and the ground-station link.
   */
  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get groundStations(): GroundStation[] {
    return this.#groundStations;
  }

  set groundStations(groundStations: GroundStation[]) {
    this.#groundStations = groundStations;
    this.clear();
  }

  get groundStationAvailable(): boolean {
    return this.#groundStations.length > 0;
  }

  get mode(): string {
    return this.#mode;
  }

  /** Overpass mode: "elevation" (line-of-sight) or "swath" (sensor footprint). */
  set mode(mode: string) {
    if (mode === this.#mode) {
      return;
    }
    this.#mode = mode;
    this.clear();
  }

  /**
   * The pass list valid around `time`, requesting a recompute if it is not.
   *
   * Recomputes only when `time` leaves the current window (±1 day around the last
   * compute, predicting 4 days ahead), which keeps the list valid after large time
   * jumps without asking on every read.
   */
  passes(time: JulianDate): Pass[] {
    if (!this.groundStationAvailable) {
      return this.#passes;
    }
    if (this.#covers(time)) {
      return this.#passes;
    }
    void this.#request(time);
    return this.#passes;
  }

  /** Resolves once the list covers `time`. For callers that cannot use a stale one. */
  ensurePasses(time: JulianDate): Promise<Pass[]> {
    if (!this.groundStationAvailable) {
      return Promise.resolve(this.#passes);
    }
    if (this.#covers(time)) {
      return Promise.resolve(this.#passes);
    }
    return this.#request(time).then(() => this.#passes);
  }

  clear(): void {
    this.#window = undefined;
    this.#passes = [];
    this.#generation += 1;
    this.passIntervals = new TimeIntervalCollection();
  }

  /**
   * Ask for the window around `time`, at most one request at a time.
   *
   * Coalesced the way the sample window is: a read arriving while a request is out
   * neither queues another — at a fast clock the reads outrun the replies — nor is
   * dropped, which would lose a clock that jumped mid-request. The latest time is
   * remembered and re-asked once.
   */
  #request(time: JulianDate): Promise<void> {
    if (this.#requesting) {
      this.#pendingTime = JulianDate.clone(time);
      // The one in flight, not a resolved promise: `ensurePasses` promises a list
      // that covers the time asked about, and resolving now would hand back the
      // stale one — empty, on a first read.
      return this.#inFlight ?? Promise.resolve();
    }
    this.#requesting = true;
    const generation = this.#generation;
    const window: PassWindow = {
      start: JulianDate.addDays(time, -1, JulianDate.clone(time)),
      stop: JulianDate.addDays(time, 1, JulianDate.clone(time)),
      stopPrediction: JulianDate.addDays(time, 4, JulianDate.clone(time)),
    };
    this.#inFlight = this.#source
      .passes({
        mode: this.#mode,
        stations: this.#groundStations.map((station) => ({ name: station.name, position: station.position })),
        startEpochMs: JulianDate.toDate(window.start).getTime(),
        endEpochMs: JulianDate.toDate(window.stopPrediction).getTime(),
        swath: this.#swath(),
      })
      .then((passes) => {
        if (generation !== this.#generation || passes === undefined) {
          return;
        }
        this.#apply(window, passes);
      })
      .finally(() => {
        this.#requesting = false;
        this.#inFlight = undefined;
        const pending = this.#pendingTime;
        this.#pendingTime = undefined;
        // Only if the window that just landed does not already cover it. Without
        // the check every reply spawned another full prediction for a time the
        // answer already included, which at a ground station over thousands of
        // satellites kept the worker recomputing the same windows forever.
        if (pending && !this.#covers(pending)) {
          void this.#request(pending);
        }
      });
    return this.#inFlight;
  }

  /** Whether the window currently held is valid at `time`. */
  #covers(time: JulianDate): boolean {
    return this.#window !== undefined && TimeInterval.contains(new TimeInterval({ start: this.#window.start, stop: this.#window.stop }), time);
  }

  #apply(window: PassWindow, passes: Pass[]): void {
    // The name is stamped here rather than in the worker, which is keyed on satnum
    // and holds no name at all. See OrbitCache.
    for (const pass of passes) {
      pass.name = this.#orbit.name;
    }
    this.#window = window;
    this.#passes = passes;
    this.passIntervals = new TimeIntervalCollection(
      passes.map(
        (pass) =>
          new TimeInterval({
            start: JulianDate.fromDate(new Date(pass.start)),
            stop: JulianDate.fromDate(new Date(pass.end)),
          }),
      ),
    );
    this.#listeners.forEach((listener) => listener());
  }
}

/**
 * Aggregate the passes of many satellites over one ground station: recompute
 * each predictor as needed, keep passes over the named station starting within
 * `deltaHours`, sorted by start time.
 */
export function stationPasses(predictors: PassPredictor[], time: JulianDate, stationName: string, deltaHours = 48): Pass[] {
  const timeDate = JulianDate.toDate(time);
  return predictors
    .flatMap((predictor) => predictor.passes(time))
    .filter((pass) => dayjs(pass.start).diff(timeDate, "hours") < deltaHours && pass.groundStationName === stationName)
    .toSorted((a, b) => a.start - b.start);
}

function pad2(num: number | string): string {
  return String(num).padStart(2, "0");
}

/**
 * Filter passes for display: by default only ongoing and upcoming passes are
 * kept; with showPast the full list (including finished passes) is returned.
 */
export function filterPasses(passes: Pass[], time: JulianDate, showPast: boolean): Pass[] {
  if (showPast) {
    return passes;
  }
  const start = dayjs(JulianDate.toDate(time));
  return passes.filter((pass) => dayjs(pass.end).isAfter(start));
}

export function formatCountdown(time: JulianDate, pass: Pass): string {
  const t = dayjs(JulianDate.toDate(time));
  if (dayjs(pass.end).diff(t) < 0) {
    return "PREVIOUS";
  }
  if (dayjs(pass.start).diff(t) > 0) {
    return `${pad2(dayjs(pass.start).diff(t, "days"))}:${pad2(dayjs(pass.start).diff(t, "hours") % 24)}:${pad2(dayjs(pass.start).diff(t, "minutes") % 60)}:${pad2(dayjs(pass.start).diff(t, "seconds") % 60)}`;
  }
  return "ONGOING";
}

export function toPassRows(passes: Pass[], time: JulianDate, nameField: "name" | "groundStationName", mode: string): PassRow[] {
  return passes.map((pass) => {
    let primary: string;
    let secondary: string;
    if (mode === "swath" && "minDistance" in pass) {
      primary = `${pass.minDistance.toFixed(1)}km`;
      secondary = `${pass.swathWidth.toFixed(0)}km`;
    } else if ("maxElevation" in pass) {
      primary = `${pass.maxElevation.toFixed(0)}°`;
      secondary = `${pass.azimuthApex.toFixed(2)}°`;
    } else {
      primary = "";
      secondary = "";
    }
    const name = pass[nameField] ?? "";
    return {
      key: `${name}-${pass.start}-${pass.end}`,
      name,
      countdown: formatCountdown(time, pass),
      startLabel: dayjs.utc(pass.start).format("DD.MM HH:mm:ss"),
      endLabel: dayjs.utc(pass.end).format("HH:mm:ss"),
      primary,
      secondary,
      startMs: pass.start,
    };
  });
}

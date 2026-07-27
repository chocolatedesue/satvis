import { JulianDate, TimeInterval, TimeIntervalCollection } from "@cesium/engine";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type Orbit from "./Orbit";
import type { ElevationPass, GroundStationPosition, SwathExtents, SwathPass } from "./Orbit";

dayjs.extend(utc);

export type Pass = (ElevationPass | SwathPass) & { groundStationName?: string };

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
 * `passes(time)` call recomputes lazily.
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

  /** Pass time ranges as Cesium intervals, kept in sync with the pass list. */
  passIntervals = new TimeIntervalCollection();

  constructor(orbit: Orbit, swath: () => SwathExtents) {
    this.#orbit = orbit;
    this.#swath = swath;
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
   * The pass list valid around `time`. Recomputes only when `time` leaves the
   * current window (±1 day around the last compute, predicting 4 days ahead),
   * which keeps the list valid after large time jumps without recomputing on
   * every read.
   */
  passes(time: JulianDate): Pass[] {
    if (!this.groundStationAvailable) {
      return this.#passes;
    }
    if (this.#window && TimeInterval.contains(new TimeInterval({ start: this.#window.start, stop: this.#window.stop }), time)) {
      return this.#passes;
    }
    this.#recompute(time);
    return this.#passes;
  }

  clear(): void {
    this.#window = undefined;
    this.#passes = [];
    this.passIntervals = new TimeIntervalCollection();
  }

  #recompute(time: JulianDate): void {
    this.#window = {
      start: JulianDate.addDays(time, -1, JulianDate.clone(time)),
      stop: JulianDate.addDays(time, 1, JulianDate.clone(time)),
      stopPrediction: JulianDate.addDays(time, 4, JulianDate.clone(time)),
    };

    const allPasses: Pass[] = [];
    this.#groundStations.forEach((groundStation) => {
      let passes: Pass[];
      if (this.#mode === "swath") {
        passes = this.#orbit.computePassesSwath(groundStation.position, this.#swath(), JulianDate.toDate(this.#window!.start), JulianDate.toDate(this.#window!.stopPrediction));
      } else {
        passes = this.#orbit.computePassesElevation(groundStation.position, JulianDate.toDate(this.#window!.start), JulianDate.toDate(this.#window!.stopPrediction));
      }
      passes.forEach((pass) => {
        pass.groundStationName = groundStation.name;
      });
      allPasses.push(...passes);
    });

    allPasses.sort((a, b) => a.start - b.start);

    this.#passes = allPasses;
    this.passIntervals = new TimeIntervalCollection(
      allPasses.map(
        (pass) =>
          new TimeInterval({
            start: JulianDate.fromDate(new Date(pass.start)),
            stop: JulianDate.fromDate(new Date(pass.end)),
          }),
      ),
    );
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

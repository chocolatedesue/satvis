import { JulianDate } from "@cesium/engine";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type Orbit from "../Orbit";
import type { Pass } from "../SatelliteProperties";
import { recordTleLines } from "./gp";

dayjs.extend(utc);

function pad2(num: number | string): string {
  return String(num).padStart(2, "0");
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

/** Drop passes that have already ended relative to the given time. */
export function upcomingPasses(passes: Pass[], time: JulianDate): Pass[] {
  const start = dayjs(JulianDate.toDate(time));
  const upcomingPassIdx = passes.findIndex((pass) => dayjs(pass.end).isAfter(start));
  if (upcomingPassIdx < 0) {
    return [];
  }
  return passes.slice(upcomingPassIdx);
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

export type ElementsInfo = { kind: "tle"; epoch: string; lines: string } | { kind: "omm"; epoch: string; rows: [string, string][] };

export function getElementsInfo(orbit: Orbit): ElementsInfo {
  const epoch = formatEpoch(orbit.julianDate);
  if (orbit.record.kind === "tle") {
    // TLE-sourced: the two element-set lines.
    const tle = orbit.tle ?? recordTleLines(orbit.record)!;
    return { kind: "tle", epoch, lines: tle.slice(1, 3).join("\n") };
  }
  // OMM-sourced: a compact element table.
  const { omm } = orbit.record;
  const rows: [string, unknown][] = [
    ["OBJECT_ID", omm.OBJECT_ID],
    ["NORAD_CAT_ID", omm.NORAD_CAT_ID],
    ["INCLINATION", omm.INCLINATION],
    ["RA_OF_ASC_NODE", omm.RA_OF_ASC_NODE],
    ["ECCENTRICITY", omm.ECCENTRICITY],
    ["ARG_OF_PERICENTER", omm.ARG_OF_PERICENTER],
    ["MEAN_ANOMALY", omm.MEAN_ANOMALY],
    ["MEAN_MOTION", omm.MEAN_MOTION],
    ["BSTAR", omm.BSTAR],
  ];
  return {
    kind: "omm",
    epoch,
    rows: rows.filter(([, value]) => value !== undefined && value !== null).map(([label, value]) => [label, String(value)]),
  };
}

export function formatEpoch(julianDate: number): string {
  const julianDayNumber = Math.floor(julianDate);
  const secondsOfDay = (julianDate - julianDayNumber) * 60 * 60 * 24;
  const epochDate = new JulianDate(julianDayNumber, secondsOfDay);
  return dayjs.utc(epochDate as unknown as Date).format("YYYY-MM-DD HH:mm:ss");
}

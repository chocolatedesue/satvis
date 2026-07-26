import { JulianDate } from "@cesium/engine";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type Orbit from "../Orbit";
import { recordTleLines } from "./gp";

dayjs.extend(utc);

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

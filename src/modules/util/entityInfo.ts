import { JulianDate } from "@cesium/engine";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type { SatelliteMetadata } from "../../config/satelliteMetadata";
import type Orbit from "../Orbit";
import { recordTleLines } from "./gp";

dayjs.extend(utc);

export type ElementsInfo = { kind: "tle"; epoch: string; lines: string } | { kind: "omm"; epoch: string; rows: [string, string][] };

/**
 * Label/value rows describing the satellite itself, as opposed to its orbit
 * elements or current position: the derived orbit class plus whatever static
 * facts its record carries.
 *
 * Only the orbit class is unconditional, because it is derived from the element
 * set every satellite has. Every other row appears only when the record actually
 * carries the field — a satellite absent from the satellite table shows nothing
 * rather than the fallback values the renderer happens to use, which would read
 * as data about the satellite when it is really a default.
 */
export function getSatelliteInfo(orbit: Orbit, metadata: SatelliteMetadata): [string, string][] {
  const rows: [string, string][] = [["Orbit", orbit.orbitClass]];

  const { swathStarboardKm, swathPortKm, coneFovDeg, operator, missionType } = metadata;
  if (swathStarboardKm !== undefined && swathPortKm !== undefined) {
    const total = swathStarboardKm + swathPortKm;
    // Spell out the sides only when they differ — otherwise the total says it all.
    rows.push(["Swath", swathStarboardKm === swathPortKm ? `${total} km` : `${total} km (${swathStarboardKm} stbd / ${swathPortKm} port)`]);
  }
  if (coneFovDeg !== undefined) {
    rows.push(["Sensor FOV", `${coneFovDeg}°`]);
  }
  if (operator !== undefined) {
    rows.push(["Operator", operator]);
  }
  if (missionType !== undefined) {
    rows.push(["Mission", missionType]);
  }
  return rows;
}

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

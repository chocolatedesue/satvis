import { JulianDate } from "@cesium/engine";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type { OrbitClass } from "../../config/orbitClass";
import { satcatLabel, SATCAT_LAUNCH_SITE, SATCAT_OPS_STATUS, SATCAT_ORBIT_TYPE, SATCAT_OWNER } from "../../config/satcatCodes";
import { swathExtentsOf, type SatelliteMetadata } from "../../config/satelliteMetadata";
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
 *
 * Takes the class rather than reading it off the metadata bag, so the caller
 * resolves the one cache miss (`CatalogEntry.orbitClass`) instead of this
 * function needing a second opinion about how to derive it.
 */
export function getSatelliteInfo(orbitClass: OrbitClass, metadata: SatelliteMetadata): [string, string][] {
  const rows: [string, string][] = [["Orbit", orbitClass]];

  const { coneFovDeg, operator, missionType, owner, launchDate, launchSite, opsStatus, orbitType, decayDate } = metadata;
  const extents = swathExtentsOf(metadata);
  if (extents !== undefined) {
    const { starboardKm, portKm } = extents;
    const total = starboardKm + portKm;
    // Spell out the sides only when they differ — otherwise the total says it all.
    rows.push(["Swath", starboardKm === portKm ? `${total} km` : `${total} km (${starboardKm} stbd / ${portKm} port)`]);
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
  if (owner !== undefined) {
    rows.push(["Owner", satcatLabel(SATCAT_OWNER, owner)]);
  }
  if (launchDate !== undefined) {
    // One row, not two: the site alone reads as a fact about a place rather than
    // about this satellite, and the pair is how anyone actually reads it.
    rows.push(["Launched", launchSite === undefined ? launchDate : `${launchDate} · ${satcatLabel(SATCAT_LAUNCH_SITE, launchSite)}`]);
  }
  if (opsStatus !== undefined) {
    rows.push(["Status", satcatLabel(SATCAT_OPS_STATUS, opsStatus)]);
  }
  // "Orbiting" is true of all but a handful of the satellites served, so stating
  // it would cost a row on every panel to say nothing. Docked, impacted and
  // landed are the cases worth a line.
  if (orbitType !== undefined && orbitType !== "ORB") {
    rows.push(["Orbit type", satcatLabel(SATCAT_ORBIT_TYPE, orbitType)]);
  }
  if (decayDate !== undefined) {
    rows.push(["Decayed", decayDate]);
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

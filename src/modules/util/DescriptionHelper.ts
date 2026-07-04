import { CallbackProperty, JulianDate } from "@cesium/engine";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import utc from "dayjs/plugin/utc";

import type { GroundStationPositionData } from "../GroundStationEntity";
import type Orbit from "../Orbit";
import type { GeodeticPosition } from "../Orbit";
import type { Pass, SatelliteProperties } from "../SatelliteProperties";

dayjs.extend(relativeTime);
dayjs.extend(utc);

function pad2(num: number | string): string {
  return String(num).padStart(2, "0");
}

export class DescriptionHelper {
  /** cachedCallbackProperty
   * Caches the results of a callback property to prevent unnecessary recalculation.
   */
  static cachedCallbackProperty<T>(callback: (time: JulianDate) => T, updateTreshold = 1, usageTreshold = 1000): CallbackProperty {
    let cache: { time: JulianDate; content: T; usage: number } | undefined;
    return new CallbackProperty((time?: JulianDate) => {
      const t = time ?? JulianDate.now();
      if (cache && JulianDate.equalsEpsilon(t, cache.time, updateTreshold) && cache.usage < usageTreshold) {
        cache.usage += 1;
        return cache.content;
      }
      const content = callback(t);
      cache = {
        time: t,
        content,
        usage: 0,
      };
      return content;
    }, false);
  }

  static renderSatelliteDescription(time: JulianDate, position: GeodeticPosition, props: SatelliteProperties): string {
    const { name, passes, orbit, overpassMode } = props;
    const description = `
      <div class="ib">
        <h3>Position</h3>
        <table class="ibt">
          <thead>
            <tr>
              <th>Name</th>
              <th>Latitude</th>
              <th>Longitude</th>
              <th>Altitude</th>
              <th>Velocity</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${name}</td>
              <td>${position.latitude.toFixed(2)}&deg</td>
              <td>${position.longitude.toFixed(2)}&deg</td>
              <td>${(position.height / 1000).toFixed(2)} km</td>
              <td>${(position.velocity ?? 0).toFixed(2)} km/s</td>
            </tr>
          </tbody>
        </table>
        ${this.renderPasses(passes, time, false, overpassMode)}
        ${this.renderElements(orbit)}
      </div>
    `;
    return description;
  }

  static renderGroundstationDescription(time: JulianDate, name: string, position: GroundStationPositionData, passes: Pass[], overpassMode: string | null = null): string {
    const description = `
      <div class="ib">
        <h3>Position</h3>
        <table class="ibt">
          <thead>
            <tr>
              <th>Name</th>
              <th>Latitude</th>
              <th>Longitude</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${name}</td>
              <td>${position.latitude.toFixed(2)}&deg</td>
              <td>${position.longitude.toFixed(2)}&deg</td>
            </tr>
          </tbody>
        </table>
        ${this.renderPasses(passes, time, true, overpassMode)}
      </div>
    `;
    return description;
  }

  static renderPasses(passes: Pass[], time: JulianDate, isGroundStation: boolean, overpassMode: string | null): string {
    if (passes.length === 0) {
      if (isGroundStation) {
        return `
          <h3>Passes</h3>
          <div class="ib-text">No passes available</div>
          `;
      }
      return `
        <h3>Passes</h3>
        <div class="ib-text">No ground station set</div>
        `;
    }

    const start = dayjs(JulianDate.toDate(time));
    const upcomingPassIdx = passes.findIndex((pass: Pass) => dayjs(pass.end).isAfter(start));
    if (upcomingPassIdx < 0) {
      return "";
    }
    const upcomingPasses = passes.slice(upcomingPassIdx);

    const passNameField: "name" | "groundStationName" = isGroundStation ? "name" : "groundStationName";
    const mode = overpassMode ?? "elevation";
    const html = `
      <h3>Passes (${mode.charAt(0).toUpperCase() + mode.slice(1)})</h3>
      <table class="ibt">
        <thead>
          <tr>
            <th>Name</th>
            <th>Countdown</th>
            <th>Start</th>
            <th>End</th>
            <th>${mode === "elevation" ? "El" : "Dist"}</th>
            <th>${mode === "elevation" ? "Az" : "Swath"}</th>
          </tr>
        </thead>
        <tbody>
          ${upcomingPasses.map((pass: Pass) => this.renderPass(start, pass, passNameField, mode)).join("")}
        </tbody>
      </table>
    `;
    return html;
  }

  static renderPass(time: dayjs.Dayjs | JulianDate, pass: Pass, passNameField: "name" | "groundStationName" = "name", overpassMode: string = "elevation"): string {
    const t = dayjs.isDayjs(time) ? time : dayjs(JulianDate.toDate(time));
    let countdown = "ONGOING";
    if (dayjs(pass.end).diff(t) < 0) {
      countdown = "PREVIOUS";
    } else if (dayjs(pass.start).diff(t) > 0) {
      countdown = `${pad2(dayjs(pass.start).diff(t, "days"))}:${pad2(dayjs(pass.start).diff(t, "hours") % 24)}:${pad2(dayjs(pass.start).diff(t, "minutes") % 60)}:${pad2(dayjs(pass.start).diff(t, "seconds") % 60)}`;
    }
    const htmlName = `<td>${pass[passNameField] ?? ""}</td>\n`;

    // Handle different pass types based on overpass mode
    let elevationCell: string;
    let azimuthCell: string;
    if (overpassMode === "swath" && "minDistance" in pass) {
      elevationCell = `${pass.minDistance.toFixed(1)}km`;
      azimuthCell = `${pass.swathWidth.toFixed(0)}km`;
    } else if ("maxElevation" in pass) {
      // Default to elevation mode
      elevationCell = `${pass.maxElevation.toFixed(0)}&deg`;
      azimuthCell = `${pass.azimuthApex.toFixed(2)}&deg`;
    } else {
      elevationCell = "";
      azimuthCell = "";
    }

    const html = `
      <tr>
        ${htmlName}
        <td>${countdown}</td>
        <td><a onclick='parent.postMessage(${JSON.stringify(pass)}, "*")'>${dayjs.utc(pass.start).format("DD.MM HH:mm:ss")}</td>
        <td>${dayjs.utc(pass.end).format("HH:mm:ss")}</td>
        <td class="ibt-right">${elevationCell}</td>
        <td class="ibt-right">${azimuthCell}</td>
      </tr>
    `;
    return html;
  }

  static renderElements(orbit: Orbit): string {
    const formattedDate = this.formatEpoch(orbit.julianDate);
    if (orbit.tle) {
      // TLE-sourced: render the two element-set lines as today.
      return `
      <h3>TLE (Epoch ${formattedDate})</h3>
      <div class="ib-code"><code>${orbit.tle.slice(1, 3).join("\n")}</code></div>`;
    }
    // OMM-sourced: render a compact element table.
    const omm = orbit.record?.kind === "omm" ? orbit.record.omm : undefined;
    if (!omm) {
      return "";
    }
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
    const body = rows
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([label, value]) => `<tr><td>${label}</td><td class="ibt-right">${value}</td></tr>`)
      .join("");
    return `
      <h3>Elements (Epoch ${formattedDate})</h3>
      <table class="ibt">
        <tbody>
          ${body}
        </tbody>
      </table>`;
  }

  static formatEpoch(julianDate: number): string {
    const julianDayNumber = Math.floor(julianDate);
    const secondsOfDay = (julianDate - julianDayNumber) * 60 * 60 * 24;
    const epochDate = new JulianDate(julianDayNumber, secondsOfDay);
    return dayjs.utc(epochDate as unknown as Date).format("YYYY-MM-DD HH:mm:ss");
  }
}

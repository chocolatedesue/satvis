import { CallbackProperty, JulianDate } from "@cesium/engine";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import utc from "dayjs/plugin/utc";

dayjs.extend(relativeTime);
dayjs.extend(utc);

function pad2(num: number | string): string {
  return String(num).padStart(2, "0");
}

// Loose typings for Pass and related domain objects; tighten when domain modules
// are migrated in Phase 2.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pass = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Position = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SatelliteDescriptionProps = any;

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

  static renderSatelliteDescription(time: JulianDate, position: Position, props: SatelliteDescriptionProps): string {
    const { name, passes, orbit, overpassMode } = props;
    const { tle, julianDate } = orbit;
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
              <td>${position.velocity.toFixed(2)} km/s</td>
            </tr>
          </tbody>
        </table>
        ${this.renderPasses(passes, time, false, overpassMode)}
        ${this.renderTLE(tle, julianDate)}
      </div>
    `;
    return description;
  }

  static renderGroundstationDescription(time: JulianDate, name: string, position: Position, passes: Pass[], overpassMode: string | null = null): string {
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

    const passNameField = isGroundStation ? "name" : "groundStationName";
    const htmlName = passNameField ? "<th>Name</th>\n" : "";
    const mode = overpassMode ?? "elevation";
    const html = `
      <h3>Passes (${mode.charAt(0).toUpperCase() + mode.slice(1)})</h3>
      <table class="ibt">
        <thead>
          <tr>
            ${htmlName}
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

  static renderPass(time: dayjs.Dayjs | JulianDate, pass: Pass, passNameField: string = "name", overpassMode: string = "elevation"): string {
    const t = dayjs.isDayjs(time) ? time : dayjs(JulianDate.toDate(time));
    let countdown = "ONGOING";
    if (dayjs(pass.end).diff(t) < 0) {
      countdown = "PREVIOUS";
    } else if (dayjs(pass.start).diff(t) > 0) {
      countdown = `${pad2(dayjs(pass.start).diff(t, "days"))}:${pad2(dayjs(pass.start).diff(t, "hours") % 24)}:${pad2(dayjs(pass.start).diff(t, "minutes") % 60)}:${pad2(dayjs(pass.start).diff(t, "seconds") % 60)}`;
    }
    const htmlName = passNameField ? `<td>${pass[passNameField]}</td>\n` : "";

    // Handle different pass types based on overpass mode
    let elevationCell: string;
    let azimuthCell: string;
    if (overpassMode === "swath") {
      elevationCell = `${pass.minDistance.toFixed(1)}km`;
      azimuthCell = `${pass.swathWidth.toFixed(0)}km`;
    } else {
      // Default to elevation mode
      elevationCell = `${pass.maxElevation.toFixed(0)}&deg`;
      azimuthCell = `${pass.azimuthApex.toFixed(2)}&deg`;
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

  static renderTLE(tle: string[], julianDate: number): string {
    const julianDayNumber = Math.floor(julianDate);
    const secondsOfDay = (julianDate - julianDayNumber) * 60 * 60 * 24;
    const tleDate = new JulianDate(julianDayNumber, secondsOfDay);
    const formattedDate = dayjs.utc(tleDate as unknown as Date).format("YYYY-MM-DD HH:mm:ss");
    const html = `
      <h3>TLE (Epoch ${formattedDate})</h3>
      <div class="ib-code"><code>${tle.slice(1, 3).join("\n")}</code></div>`;
    return html;
  }
}

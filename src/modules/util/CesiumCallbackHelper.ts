import { JulianDate } from "@cesium/engine";

// Use `any` for Cesium viewer/event - tightening Cesium types is out of scope.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Viewer = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CesiumEvent = any;

export class CesiumCallbackHelper {
  /**
   * Register an event listener that will execute a callback every refreshRate ticks of clock time.
   * @returns function to remove the event listener
   */
  static createPeriodicTickCallback(viewer: Viewer, refreshRate: number, callback: (time: JulianDate) => void, event: CesiumEvent = viewer.clock.onTick): () => void {
    let ticks = 0;
    return event.addEventListener(() => {
      if (ticks < refreshRate) {
        ticks += 1;
        return;
      }
      callback(viewer.clock.currentTime);
      ticks = 0;
    });
  }

  /**
   * Register an event listener that will execute a callback every refreshRate seconds of clock time.
   * @returns function to remove the event listener
   */
  static createPeriodicTimeCallback(viewer: Viewer, refreshRate: number, callback: (time: JulianDate) => void, event: CesiumEvent = viewer.clock.onTick): () => void {
    let lastUpdated = viewer.clock.currentTime;
    return event.addEventListener(() => {
      const time = viewer.clock.currentTime;
      const delta = Math.abs(JulianDate.secondsDifference(time, lastUpdated));
      if (delta < refreshRate) {
        return;
      }
      callback(time);
      lastUpdated = time;
    });
  }
}

// The numbers behind the sky view's overlay: tape ticks, the locked satellite,
// and its track across the sky. The component that draws them holds no geometry.
//
// Everything positional goes through Cesium's own projection, never through
// `(azimuth - heading) * pixelsPerDegree`. That shortcut assumes an upright
// camera that never looks straight up: crossing the zenith flips the derived
// heading by 180° and throws a tick most of the way across the viewport in a
// quarter-degree step, while the satellites — correctly projected — carry on
// smoothly, so it reads as the satellites jumping rather than the tape.
//
// State is published as shallow refs updated from `preRender`. The arrays are
// replaced wholesale each frame, which is cheap at this size and avoids making
// every tick individually reactive.

import { type Cartesian3, JulianDate, type Scene, SceneTransforms } from "@cesium/engine";
import { shallowRef, type ShallowRef } from "vue";

import { compassPoint, directionToWindow, lookAngles, type ObserverFrame, type SkyTarget } from "../modules/SkyTargets";

/** A mark on one of the tapes, already placed in CSS pixels. */
export interface TapeTick {
  /** Degrees the tick stands for — azimuth on the compass, elevation on the side. */
  value: number;
  /** Position along the tape, in CSS pixels. */
  offset: number;
  label: string | undefined;
  major: boolean;
}

const COMPASS_STEP = 15;
const COMPASS_LABEL_STEP = 45;
const ELEVATION_STEP = 15;

/**
 * Ticks closer together than this are thinned away. Thinning by screen distance
 * rather than at a pitch threshold is what makes the tape degrade gracefully:
 * near the zenith every azimuth converges on the crosshair, so ticks drop out
 * progressively instead of the whole tape vanishing at once.
 */
const MIN_TICK_SPACING = 26;

const TRACE_BACK_SECONDS = 4 * 60;
const TRACE_FORWARD_SECONDS = 8 * 60;
const TRACE_STEP_SECONDS = 30;

/** The trace moves slowly; recomputing it every frame would be waste. */
const TRACE_INTERVAL_MS = 500;

export interface SkyHudState {
  compass: ShallowRef<TapeTick[]>;
  elevation: ShallowRef<TapeTick[]>;
  locked: ShallowRef<SkyTarget | undefined>;
  /** An SVG path for the locked satellite's track, or "" when there is none. */
  trace: ShallowRef<string>;
}

/**
 * Drop ticks that would overprint their neighbours. Input is assumed sorted by
 * the axis being thinned; the first of any cluster wins, so which ticks survive
 * is stable from frame to frame rather than flickering between them.
 */
function thin(ticks: TapeTick[]): TapeTick[] {
  const kept: TapeTick[] = [];
  // Majors are placed first so a label is never the one thinned away in favour
  // of the minor tick beside it.
  for (const tick of ticks.toSorted((a, b) => Number(b.major) - Number(a.major))) {
    if (kept.every((other) => Math.abs(other.offset - tick.offset) >= MIN_TICK_SPACING)) {
      kept.push(tick);
    }
  }
  return kept.toSorted((a, b) => a.offset - b.offset);
}

export function useSkyHud(): SkyHudState & { start: () => void; stop: () => void } {
  const compass = shallowRef<TapeTick[]>([]);
  const elevation = shallowRef<TapeTick[]>([]);
  const locked = shallowRef<SkyTarget | undefined>(undefined);
  const trace = shallowRef("");

  let removePreRender: (() => void) | undefined;
  let sampledAt = 0;
  let sampledFor = "";
  // World positions, not window coordinates. Only the propagation is worth
  // caching: where a position lands on screen depends on the camera, so a cached
  // path would visibly detach from its satellite the moment the view moved.
  let samples: Cartesian3[] = [];

  function refresh(time: JulianDate): void {
    const { viewer, skyView, skyInteraction } = globalThis.cc;
    const { scene } = viewer;
    const frame = skyView.frame;
    if (!skyView.active || !frame) {
      return;
    }

    const compassTicks: TapeTick[] = [];
    for (let azimuth = 0; azimuth < 360; azimuth += COMPASS_STEP) {
      const window = directionToWindow(scene, frame, azimuth, 0);
      if (!window) {
        continue;
      }
      const major = azimuth % COMPASS_LABEL_STEP === 0;
      compassTicks.push({ value: azimuth, offset: window.x, label: major ? compassPoint(azimuth) : undefined, major });
    }
    compass.value = thin(compassTicks);

    const elevationTicks: TapeTick[] = [];
    const { azimuth: viewAzimuth } = skyView.aim;
    for (let angle = -90; angle <= 90; angle += ELEVATION_STEP) {
      const window = directionToWindow(scene, frame, viewAzimuth, angle);
      if (!window) {
        continue;
      }
      elevationTicks.push({ value: angle, offset: window.y, label: `${angle}°`, major: angle % 30 === 0 });
    }
    elevation.value = thin(elevationTicks);

    locked.value = skyInteraction.locked;
    sampleTrace(time);
    trace.value = projectTrace(scene, frame);
  }

  /** Re-propagate the locked satellite's track, at most every TRACE_INTERVAL_MS. */
  function sampleTrace(time: JulianDate): void {
    const target = locked.value;
    if (!target) {
      samples = [];
      sampledFor = "";
      return;
    }
    const now = performance.now();
    if (target.name === sampledFor && now - sampledAt < TRACE_INTERVAL_MS) {
      return;
    }
    sampledAt = now;
    sampledFor = target.name;

    const at = new JulianDate();
    samples = [];
    for (let offset = -TRACE_BACK_SECONDS; offset <= TRACE_FORWARD_SECONDS; offset += TRACE_STEP_SECONDS) {
      JulianDate.addSeconds(time, offset, at);
      const position = target.sat.props.trajectory.position(at);
      if (position) {
        samples.push(position);
      }
    }
  }

  /** Project the cached track for this frame's camera. */
  function projectTrace(scene: Scene, frame: ObserverFrame): string {
    // Broken into runs rather than one polyline: a track that dips below the
    // horizon and comes back must not be joined straight through the Earth.
    const runs: string[] = [];
    let current: string[] = [];
    for (const position of samples) {
      // Dropped rather than clipped, for the same reason.
      const window = lookAngles(frame, position).elevation > 0 ? SceneTransforms.worldToWindowCoordinates(scene, position) : undefined;
      if (!window) {
        if (current.length > 1) {
          runs.push(current.join(" "));
        }
        current = [];
        continue;
      }
      current.push(`${current.length === 0 ? "M" : "L"}${window.x.toFixed(1)},${window.y.toFixed(1)}`);
    }
    if (current.length > 1) {
      runs.push(current.join(" "));
    }
    return runs.join(" ");
  }

  return {
    compass,
    elevation,
    locked,
    trace,
    start(): void {
      if (removePreRender) {
        return;
      }
      removePreRender = globalThis.cc.viewer.scene.preRender.addEventListener((_scene, time: JulianDate) => refresh(time));
    },
    stop(): void {
      removePreRender?.();
      removePreRender = undefined;
      compass.value = [];
      elevation.value = [];
      locked.value = undefined;
      trace.value = "";
    },
  };
}

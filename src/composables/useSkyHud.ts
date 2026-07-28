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

import { type Cartesian3, Math as CesiumMath, JulianDate, type Scene, SceneTransforms } from "@cesium/engine";
import { shallowRef, type ShallowRef } from "vue";

import { normalizeAzimuth } from "../modules/skyGeometry";
import { compassPoint, directionToWindow, lookAngles, type ObserverFrame, type SkyTarget } from "../modules/SkyTargets";
import { fovxFromFovy } from "../modules/SkyView";

/** A mark on one of the tapes, already placed in CSS pixels. */
export interface TapeTick {
  /** Degrees the tick stands for — azimuth on the compass, elevation on the side. */
  value: number;
  /** Position along the tape, in CSS pixels. */
  offset: number;
  label: string | undefined;
  major: boolean;
}

/**
 * Tick spacings to choose from, coarsest first.
 *
 * Every rung divides 45, which is what lets a label rule as simple as "majors are
 * multiples of three steps" always keep the compass points among the majors. And
 * no rung is more than three times the next, which is what bounds the mark count:
 * 3 exists only to break the 5-to-1 jump, without which a span of 15° would skip
 * from three marks to fifteen.
 *
 * A fixed 15° step used to empty both tapes out when zoomed: at maximum zoom a
 * portrait viewport spans about 4.6° of azimuth, so the nearest 15° mark was
 * usually off screen and the tape showed nothing at all.
 */
const STEP_LADDER = [45, 15, 5, 3, 1];

/**
 * How many marks the span should hold before a finer step is chosen. Three keeps
 * the step at 15° on a landscape desktop at the default zoom, which is what it has
 * always been there, and holds the resulting count between about three and ten
 * everywhere else. Four sounds better and is worse: the rungs are 3x apart, so
 * asking for four marks at a span of 17° skips 5° and lands on 1°, which is
 * seventeen of them.
 */
export const TICKS_WANTED = 3;

/** The coarsest step that still populates the span. */
export const stepFor = (spanDegrees: number): number => STEP_LADDER.find((step) => spanDegrees / step >= TICKS_WANTED) ?? 1;

/** Majors carry the labels. At 45° every tick is a compass point, so all are. */
export const majorStep = (step: number): number => (step === 45 ? 45 : step * 3);

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
  /**
   * Whether the compass knows where north is. Read here rather than pushed,
   * because it latches inside the sensor callback — and this is already the
   * per-frame read of sky state.
   */
  calibrated: ShallowRef<boolean>;
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
  const calibrated = shallowRef(false);

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

    const { azimuth: viewAzimuth, pitch: viewPitch } = skyView.aim;
    const { clientWidth, clientHeight } = scene.canvas;
    const aspectRatio = clientHeight > 0 ? clientWidth / clientHeight : 1;
    const verticalSpan = skyView.fovy;
    const horizontalSpan = CesiumMath.toDegrees(fovxFromFovy(CesiumMath.toRadians(verticalSpan), aspectRatio));

    const compassStep = stepFor(horizontalSpan);
    const compassMajor = majorStep(compassStep);
    const compassTicks: TapeTick[] = [];
    // Azimuths crowd together as the view rises — at the zenith every one of them
    // is on screen at once — so the window has to widen by the same 1/cos(pitch)
    // they compress by, up to the whole circle. Windowing at all is what keeps the
    // work proportional to what is visible rather than to 360/step, which at
    // maximum zoom would be 360 projections a frame.
    const azimuthHalf = Math.min(180, (horizontalSpan / 2 + compassStep) / Math.max(Math.cos(CesiumMath.toRadians(viewPitch)), 1e-3));
    const firstAzimuth = Math.ceil((viewAzimuth - azimuthHalf) / compassStep) * compassStep;
    for (let azimuth = firstAzimuth; azimuth <= viewAzimuth + azimuthHalf; azimuth += compassStep) {
      const window = directionToWindow(scene, frame, azimuth, 0);
      if (!window) {
        continue;
      }
      const value = normalizeAzimuth(azimuth);
      const major = value % compassMajor === 0 || value % 45 === 0;
      // Numeric where the tick is not a compass point: at a fine step the nearest
      // cardinal is often off screen, and an unlabelled tape says nothing about
      // which way the viewer is facing.
      compassTicks.push({ value, offset: window.x, label: major ? (value % 45 === 0 ? compassPoint(value) : `${value}°`) : undefined, major });
    }
    compass.value = thin(compassTicks);

    const elevationStep = stepFor(verticalSpan);
    const elevationMajor = majorStep(elevationStep);
    const elevationTicks: TapeTick[] = [];
    const elevationHalf = verticalSpan / 2 + elevationStep;
    const firstElevation = Math.max(-90, Math.ceil((viewPitch - elevationHalf) / elevationStep) * elevationStep);
    for (let angle = firstElevation; angle <= Math.min(90, viewPitch + elevationHalf); angle += elevationStep) {
      const window = directionToWindow(scene, frame, viewAzimuth, angle);
      if (!window) {
        continue;
      }
      elevationTicks.push({ value: angle, offset: window.y, label: `${angle}°`, major: angle % elevationMajor === 0 });
    }
    elevation.value = thin(elevationTicks);

    locked.value = skyInteraction.locked;
    calibrated.value = skyInteraction.compass.calibrated;
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
    calibrated,
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
      calibrated.value = false;
    },
  };
}

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
 * 15° is the coarsest deliberately. A 45° rung would only ever be reached above a
 * 135° span — unreachable until the zoom ceiling went to 100° — and crossing into
 * it thinned the tape from nine marks to three in the space of a few degrees of
 * zoom. Losing it costs nothing anyone has seen and removes the one place the
 * density jumped by 3x.
 *
 * A fixed 15° step used to empty both tapes out when zoomed: at maximum zoom a
 * portrait viewport spans about 4.6° of azimuth, so the nearest 15° mark was
 * usually off screen and the tape showed nothing at all.
 */
const STEP_LADDER = [15, 5, 3, 1];

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

/** Majors carry the labels. Three steps apart, which every rung keeps a divisor of 45. */
export const majorStep = (step: number): number => step * 3;

/**
 * Where a bearing sits on the compass tape, in pixels from the left edge.
 *
 * The same `tan` mapping a perspective camera applies, minus the pitch: at eye level
 * this is exactly where the projection of that bearing on the horizon lands, and at
 * every other pitch it is the same scale rather than a projection. See the note in
 * `refresh` for why the pitch term is deliberately absent.
 */
export const headingOffset = (deltaAzimuth: number, halfWidth: number, tanHalfSpan: number): number =>
  halfWidth + (halfWidth * Math.tan(CesiumMath.toRadians(deltaAzimuth))) / tanHalfSpan;

/**
 * Ticks closer together than this are thinned away. It applies to the elevation
 * tape, whose ticks crowd together as the view tips toward the zenith and the
 * projection compresses them; the compass tape is evenly spaced by construction
 * and never triggers it.
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
  /**
   * Whether the camera has finished flying in. Everything below is computed from
   * the aim, and during the flight the aim is where the camera is going rather
   * than where it is looking — so the overlay has nothing true to say yet, and
   * the component keeps it out of sight until this turns true.
   */
  settled: ShallowRef<boolean>;
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
  const settled = shallowRef(false);

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
    settled.value = skyView.settled;
    // `settled`, not `active`: while the camera is still descending, every tick
    // below would be projected against a camera that is nowhere near the
    // observer, and the tapes would swim across the screen behind the fade.
    if (!skyView.settled || !frame) {
      return;
    }

    const { azimuth: viewAzimuth, pitch: viewPitch } = skyView.aim;
    const { clientWidth, clientHeight } = scene.canvas;
    const aspectRatio = clientHeight > 0 ? clientWidth / clientHeight : 1;
    const verticalSpan = skyView.fovy;
    const horizontalSpan = CesiumMath.toDegrees(fovxFromFovy(CesiumMath.toRadians(verticalSpan), aspectRatio));

    // The compass tape is a heading readout, not a projection of the horizon.
    //
    // Projecting horizon directions is what it used to do, and the scale then grew
    // as 1/cos(pitch): on a 390px phone, 15° of azimuth spanned 147px at eye level
    // and 1691px at 85° of pitch, so looking up zoomed the tape until the visible
    // window collapsed from ±15° to nothing. That factor was buying registration —
    // the tick sitting above the bearing you would actually see — and registration
    // only means anything while the horizon is on screen, which holds when
    // `pitch < fovy/2` and no longer at any zoom (see docs/adr/0003-sky-view.md).
    // The band is drawn at a fixed height near the top of the viewport, so above
    // that limit it was spreading for a horizon nobody could see.
    //
    // Dropping the pitch term leaves the same tan mapping the projection uses at eye
    // level, where the two agree exactly, and a scale that no longer changes with
    // where the view is pointed. The cost is that above the horizon a tick is no
    // longer above the true bearing — satellites are still projected honestly, so at
    // 60° of pitch one appears about twice as far off-centre as its tick. That
    // cannot be designed away: satellites sit at different elevations, so no single
    // horizontal tape registers with all of them. The locked target's card carries
    // the numeric azimuth when a measurement is wanted.
    const tanHalfSpan = Math.tan(CesiumMath.toRadians(horizontalSpan) / 2);
    const halfWidth = clientWidth / 2;
    const compassStep = stepFor(horizontalSpan);
    const compassMajor = majorStep(compassStep);
    const compassTicks: TapeTick[] = [];
    // Exactly the visible span, with no pitch term to get wrong in either direction.
    const azimuthHalf = horizontalSpan / 2 + compassStep;
    const firstAzimuth = Math.ceil((viewAzimuth - azimuthHalf) / compassStep) * compassStep;
    for (let azimuth = firstAzimuth; azimuth <= viewAzimuth + azimuthHalf; azimuth += compassStep) {
      const offset = azimuth - viewAzimuth;
      // A quarter turn away is at infinity and beyond it is behind the viewer.
      if (Math.abs(offset) >= 90) {
        continue;
      }
      const value = normalizeAzimuth(azimuth);
      const major = value % compassMajor === 0 || value % 45 === 0;
      // Numeric where the tick is not a compass point: at a fine step the nearest
      // cardinal is often off screen, and an unlabelled tape says nothing about
      // which way the viewer is facing.
      compassTicks.push({
        value,
        offset: headingOffset(offset, halfWidth, tanHalfSpan),
        label: major ? (value % 45 === 0 ? compassPoint(value) : `${value}°`) : undefined,
        major,
      });
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
    settled,
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
      settled.value = false;
    },
  };
}

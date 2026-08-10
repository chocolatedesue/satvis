// Where things are in the observer's sky, and where that lands on screen.
//
// Two jobs, deliberately together because they share the observer's local frame:
// converting a position into the azimuth/elevation/range the sky view talks in,
// and projecting a direction to a window coordinate.
//
// The projection is Cesium's own, the same one that put the satellite on screen,
// which is why the compass and elevation tapes have to go through it too. The
// obvious `(azimuth - heading) * pixelsPerDegree` assumes an upright camera that
// never looks straight up; crossing the zenith flips the derived heading by 180°
// and throws a tick most of the way across the viewport in a quarter-degree
// step, while the satellites — correctly projected — carry on smoothly. The
// projected form also picks up roll for free, which the linear one cannot
// express at all.

import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, type JulianDate, Matrix3, Ray, type Scene, SceneTransforms } from "@cesium/engine";

import type { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { enuDirection, normalizeAzimuth, type ObserverFrame } from "./skyGeometry";

export { type ObserverFrame, observerFrame } from "./skyGeometry";

/** A position as the observer sees it. */
export interface LookAngles {
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon; negative is below it. */
  elevation: number;
  rangeKm: number;
}

/** A satellite, where it is in the sky, and where it is on screen. */
export interface SkyTarget extends LookAngles {
  sat: SatelliteComponentCollection;
  name: string;
  altitudeKm: number;
  /** Fixed-frame position, which every angle here is derived from. */
  position: Cartesian3;
  /** Window coordinates in CSS pixels, or undefined when behind the camera. */
  window: Cartesian2 | undefined;
}

/**
 * How far away to put a projected direction. Any distance works — the direction
 * is what is being projected — but it has to dwarf the observer's eye height so
 * the angle is not perturbed by it.
 */
const DIRECTION_DISTANCE = 1e7;

export function lookAngles(frame: ObserverFrame, target: Cartesian3): LookAngles {
  const delta = Cartesian3.subtract(target, frame.position, new Cartesian3());
  const range = Cartesian3.magnitude(delta);
  if (range === 0) {
    return { azimuth: 0, elevation: 0, rangeKm: 0 };
  }
  const local = Matrix3.multiplyByVector(frame.fixedToEnu, delta, new Cartesian3());
  const azimuth = normalizeAzimuth(CesiumMath.toDegrees(Math.atan2(local.x, local.y)));
  const elevation = CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(local.z / range, -1, 1)));
  return { azimuth, elevation, rangeKm: range / 1000 };
}

export function directionToWorld(frame: ObserverFrame, azimuth: number, elevation: number, distance = DIRECTION_DISTANCE): Cartesian3 {
  const local = enuDirection(azimuth, elevation, distance);
  const enuToFixed = Matrix3.transpose(frame.fixedToEnu, new Matrix3());
  const offset = Matrix3.multiplyByVector(enuToFixed, local, new Cartesian3());
  return Cartesian3.add(frame.position, offset, offset);
}

/** Where a direction from the observer lands on screen, in CSS pixels. */
export function directionToWindow(scene: Scene, frame: ObserverFrame, azimuth: number, elevation: number): Cartesian2 | undefined {
  return SceneTransforms.worldToWindowCoordinates(scene, directionToWorld(frame, azimuth, elevation));
}

/**
 * Every satellite currently in the scene, placed in the observer's sky.
 *
 * Positions come from the entity's own sampled property, so a target is where
 * Cesium is actually drawing it rather than where a second propagation would
 * put it.
 */
export function skyTargets(scene: Scene, frame: ObserverFrame, satellites: readonly SatelliteComponentCollection[], time: JulianDate): SkyTarget[] {
  const targets: SkyTarget[] = [];
  for (const sat of satellites) {
    const position = sat.props.trajectory.position(time);
    if (!position) {
      continue;
    }
    const angles = lookAngles(frame, position);
    targets.push({
      ...angles,
      sat,
      name: sat.props.name,
      position,
      // Height above the ellipsoid, not the difference of two geocentric radii:
      // the observer's own radius varies 6357-6378 km with latitude, which would
      // put a ~12 km latitude-dependent bias on every altitude reported.
      altitudeKm: (Cartographic.fromCartesian(position)?.height ?? 0) / 1000,
      window: SceneTransforms.worldToWindowCoordinates(scene, position),
    });
  }
  return targets;
}

// Reused across calls: the ray is cast per candidate per frame.
const occlusionRay = new Ray();
const occlusionHit = new Cartesian3();

/**
 * Whether the ground stands between the observer and a position — what keeps the
 * crosshair and the on-sky track agreeing with a picture that is itself
 * depth-tested against the terrain (`SkyView#enter`).
 *
 * A ray against the tiles the globe rendered last frame, so it is as coarse as the
 * terrain drawn, and false where a surface model stands in and there are none.
 */
export function groundHides(scene: Scene, frame: ObserverFrame, position: Cartesian3): boolean {
  const direction = Cartesian3.subtract(position, frame.position, occlusionRay.direction);
  const range = Cartesian3.magnitude(direction);
  if (range === 0) {
    return false;
  }
  Cartesian3.divideByScalar(direction, range, direction);
  Cartesian3.clone(frame.position, occlusionRay.origin);
  const hit = scene.globe.pick(occlusionRay, scene, occlusionHit);
  return hit !== undefined && Cartesian3.distance(frame.position, hit) < range;
}

/**
 * The target nearest the crosshair that the observer can actually see, or
 * undefined if there is none within reach.
 *
 * Targets below the horizon are dropped rather than depth-tested. This replaces
 * what `scene.pick` would have given for free, and is the reason it is not used:
 * its rectangle is in drawing-buffer pixels while a capture radius is in CSS
 * pixels, so the same argument means a 60 px reach at `?quality=low` and 20 px
 * at `?quality=high` — a crosshair whose reach depends on the quality toggle.
 * Comparing screen distances directly also gives the genuinely nearest target,
 * where the pick walks outward in square rings.
 *
 * `hidden` is asked nearest first and only until one candidate passes, because it
 * is a terrain ray: the ordinary frame spends one, not one per satellite in the sky.
 */
export function nearestTarget(targets: readonly SkyTarget[], center: Cartesian2, radiusPx: number, hidden: (target: SkyTarget) => boolean = () => false): SkyTarget | undefined {
  const inReach: { target: SkyTarget; distance: number }[] = [];
  for (const target of targets) {
    if (!target.window || target.elevation <= 0) {
      continue;
    }
    const distance = Cartesian2.distance(target.window, center);
    if (distance <= radiusPx) {
      inReach.push({ target, distance });
    }
  }
  return inReach.toSorted((a, b) => a.distance - b.distance).find(({ target }) => !hidden(target))?.target;
}

/** The compass letter for an azimuth, for the detail card. */
export function compassPoint(azimuth: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round(normalizeAzimuth(azimuth) / 22.5) % points.length;
  return points[index] as string;
}

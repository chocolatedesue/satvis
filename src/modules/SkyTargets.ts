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

import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, type JulianDate, Matrix3, Matrix4, type Scene, SceneTransforms, Transforms } from "@cesium/engine";

import type { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { enuDirection, normalizeAzimuth } from "./skyGeometry";

/** A position as the observer sees it. */
export interface LookAngles {
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon; negative is below it. */
  elevation: number;
  rangeKm: number;
}

/** The observer's local frame, prepared once and reused for every target. */
export interface ObserverFrame {
  position: Cartesian3;
  fixedToEnu: Matrix3;
}

/** A satellite, where it is in the sky, and where it is on screen. */
export interface SkyTarget extends LookAngles {
  sat: SatelliteComponentCollection;
  name: string;
  altitudeKm: number;
  /** Window coordinates in CSS pixels, or undefined when behind the camera. */
  window: Cartesian2 | undefined;
}

/**
 * How far away to put a projected direction. Any distance works — the direction
 * is what is being projected — but it has to dwarf the observer's eye height so
 * the angle is not perturbed by it.
 */
const DIRECTION_DISTANCE = 1e7;

export function observerFrame(position: Cartesian3): ObserverFrame {
  const enuToFixed = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position, undefined, new Matrix4()), new Matrix3());
  return {
    position: Cartesian3.clone(position, new Cartesian3()),
    // Orthonormal, so the transpose is the inverse and no solve is needed.
    fixedToEnu: Matrix3.transpose(enuToFixed, new Matrix3()),
  };
}

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

/** The world position a direction from the observer points at. */
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
      // Height above the ellipsoid, not the difference of two geocentric radii:
      // the observer's own radius varies 6357-6378 km with latitude, which would
      // put a ~12 km latitude-dependent bias on every altitude reported.
      altitudeKm: (Cartographic.fromCartesian(position)?.height ?? 0) / 1000,
      window: SceneTransforms.worldToWindowCoordinates(scene, position),
    });
  }
  return targets;
}

/**
 * The target nearest the crosshair, or undefined if none is within reach.
 *
 * Targets below the horizon are dropped rather than depth-tested. This replaces
 * what `scene.pick` would have given for free, and is the reason it is not used:
 * its rectangle is in drawing-buffer pixels while a capture radius is in CSS
 * pixels, so the same argument means a 60 px reach at `?quality=low` and 20 px
 * at `?quality=high` — a crosshair whose reach depends on the quality toggle.
 * Comparing screen distances directly also gives the genuinely nearest target,
 * where the pick walks outward in square rings.
 */
export function nearestTarget(targets: readonly SkyTarget[], center: Cartesian2, radiusPx: number): SkyTarget | undefined {
  let best: SkyTarget | undefined;
  let bestDistance = radiusPx;
  for (const target of targets) {
    if (!target.window || target.elevation <= 0) {
      continue;
    }
    const distance = Cartesian2.distance(target.window, center);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

/** The compass letter for an azimuth, for the detail card. */
export function compassPoint(azimuth: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round(normalizeAzimuth(azimuth) / 22.5) % points.length;
  return points[index] as string;
}

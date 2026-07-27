// The angles the sky view is built on, and the east-north-up vectors they name.
//
// One home for these because three modules need them and they have to agree
// exactly: SkyView composes a camera basis from an aim, DeviceAim decomposes a
// device's orientation back into one, and SkyTargets turns an aim into a world
// position to project. A second copy of the level basis is a sign error waiting
// to happen — composing and decomposing must be each other's inverse.

import { Cartesian3, Math as CesiumMath, Matrix3, Matrix4, Transforms } from "@cesium/engine";

/** Where the sky view looks up from — see CONTEXT.md, observer. */
export interface Observer {
  lat: number;
  lon: number;
}

/**
 * Which way the sky view is pointing: azimuth clockwise from north and pitch
 * above the horizontal, both in degrees, plus the roll about the view axis that
 * a handheld device supplies and a mouse does not.
 *
 * Pitch, not elevation. The two are equal whenever the camera is looking at
 * something — which is what makes the crosshair work — but they are different
 * roles: the camera has an attitude, a satellite has a position in the sky. This
 * codebase already spends "elevation" on the latter (see CONTEXT.md, pass, and
 * `?overpass=elevation`), and heights are called height.
 */
export interface Aim {
  azimuth: number;
  pitch: number;
  roll: number;
}

/**
 * The observer's local frame, built once and reused for every angle taken
 * against it. Owned by `SkyView`, which knows when the observer moves — building
 * one costs a 4x4 and a transpose, and three callers wanted it per frame.
 */
export interface ObserverFrame {
  position: Cartesian3;
  fixedToEnu: Matrix3;
}

export function observerFrame(position: Cartesian3): ObserverFrame {
  const enuToFixed = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position, undefined, new Matrix4()), new Matrix3());
  return {
    position: Cartesian3.clone(position, new Cartesian3()),
    // Orthonormal, so the transpose is the inverse and no solve is needed.
    fixedToEnu: Matrix3.transpose(enuToFixed, new Matrix3()),
  };
}

/** Wrap an azimuth to [0, 360). */
export const normalizeAzimuth = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** The unit vector an azimuth and elevation point along, in east-north-up. */
export function enuDirection(azimuth: number, elevation: number, distance = 1): Cartesian3 {
  const az = CesiumMath.toRadians(azimuth);
  const el = CesiumMath.toRadians(elevation);
  const cosEl = Math.cos(el);
  return new Cartesian3(Math.sin(az) * cosEl * distance, Math.cos(az) * cosEl * distance, Math.sin(el) * distance);
}

/**
 * The up/right pair for an unrolled view along that direction, in east-north-up.
 *
 * `up` is where the view axis heads as elevation increases and `right` is level
 * with the horizon, so neither is a cross product against world up — which is
 * what keeps the pair defined at the zenith, where world up and the view axis
 * are the same line.
 */
export function levelBasis(azimuth: number, elevation: number): { up: Cartesian3; right: Cartesian3 } {
  const az = CesiumMath.toRadians(azimuth);
  const el = CesiumMath.toRadians(elevation);
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  const sinEl = Math.sin(el);
  return {
    up: new Cartesian3(-sinAz * sinEl, -cosAz * sinEl, Math.cos(el)),
    right: new Cartesian3(cosAz, -sinAz, 0),
  };
}

/**
 * Roll the level pair about the view axis.
 *
 * The inverse of `rollOf`, and the reason both live here: composing with one
 * sign and decomposing with the other mirrors the view, and the two were far
 * enough apart to hide it.
 */
export function rollBasis(azimuth: number, elevation: number, roll: number): { up: Cartesian3; right: Cartesian3 } {
  const { up: levelUp, right: levelRight } = levelBasis(azimuth, elevation);
  const radians = CesiumMath.toRadians(roll);
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return {
    up: new Cartesian3(levelUp.x * cos - levelRight.x * sin, levelUp.y * cos - levelRight.y * sin, levelUp.z * cos - levelRight.z * sin),
    right: new Cartesian3(levelRight.x * cos + levelUp.x * sin, levelRight.y * cos + levelUp.y * sin, levelRight.z * cos + levelUp.z * sin),
  };
}

/** Recover the roll of an up vector about the view axis. The inverse of `rollBasis`. */
export function rollOf(azimuth: number, elevation: number, up: Cartesian3): number {
  const { up: levelUp, right: levelRight } = levelBasis(azimuth, elevation);
  return CesiumMath.toDegrees(Math.atan2(-Cartesian3.dot(up, levelRight), Cartesian3.dot(up, levelUp)));
}

import { Math as CesiumMath } from "@cesium/engine";

import type { OrbitClass } from "../config/orbitClass";

// satelliteGraphics — the geometry decisions behind the satellite's visual
// components, as pure functions of plain inputs so they are testable without
// a Cesium scene. SatelliteComponentCollection adapts these descriptions into
// Cesium entities and primitives.

/**
 * Ground track and sensor cone are only rendered for LEO satellites.
 *
 * The same "LEO" the info panel and the browser badge name, rather than a
 * period threshold of its own: the two used to disagree by 8 minutes, so a
 * satellite could be labelled LEO and still be refused a ground track. It also
 * picks up the eccentricity test for free — a highly elliptical orbit that dips
 * to a short period is not something to draw a swath corridor under.
 */
export function isLeo(orbitClass: OrbitClass): boolean {
  return orbitClass === "LEO";
}

export interface OrbitPathTimes {
  leadTime: number;
  trailTime: number;
}

/** Lead/trail half a period (+5 s overlap) so the path closes into a full orbit. */
export function orbitPathTimes(orbitalPeriodMin: number): OrbitPathTimes {
  const halfPeriod = (orbitalPeriodMin * 60) / 2 + 5;
  return { leadTime: halfPeriod, trailTime: halfPeriod };
}

/** One full period ahead, nothing behind. */
export function orbitTrackTimes(orbitalPeriodMin: number): OrbitPathTimes {
  return { leadTime: orbitalPeriodMin * 60, trailTime: 0 };
}

export interface GroundTrackDescription {
  widthMeters: number;
}

export function groundTrackDescription(orbitClass: OrbitClass, swathKm: number): GroundTrackDescription | undefined {
  if (!isLeo(orbitClass)) {
    return undefined;
  }
  return { widthMeters: swathKm * 1000 };
}

export interface ConeDescription {
  radiusMeters: number;
  innerHalfAngleRad: number;
  outerHalfAngleRad: number;
}

export function coneDescription(orbitClass: OrbitClass, fovDeg: number): ConeDescription | undefined {
  if (!isLeo(orbitClass)) {
    return undefined;
  }
  return {
    radiusMeters: 1000000,
    innerHalfAngleRad: CesiumMath.toRadians(0),
    outerHalfAngleRad: CesiumMath.toRadians(fovDeg),
  };
}

/** Explicit model URL from catalog metadata wins; otherwise the name-convention path. */
export function modelUri(name: string, modelUrl?: string): string {
  return modelUrl ?? `./data/models/${name.split(" ").join("-")}.glb`;
}

/**
 * Whether the orbit renders as a path graphic (entity) instead of a polyline
 * primitive: required for the tracked satellite and for scene modes without
 * primitive model-matrix updates; all other satellites use the significantly
 * faster primitive.
 */
export function orbitUsesPathGraphic(isTracked: boolean, sceneModeSupportsPrimitive: boolean): boolean {
  return isTracked || !sceneModeSupportsPrimitive;
}

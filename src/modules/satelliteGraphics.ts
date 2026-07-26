import { Math as CesiumMath } from "@cesium/engine";

// satelliteGraphics — the geometry decisions behind the satellite's visual
// components, as pure functions of plain inputs so they are testable without
// a Cesium scene. SatelliteComponentCollection adapts these descriptions into
// Cesium entities and primitives.

/** Ground track and sensor cone are only rendered for LEO satellites. */
export function isLeo(orbitalPeriodMin: number): boolean {
  return orbitalPeriodMin <= 60 * 2;
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

export function groundTrackDescription(orbitalPeriodMin: number, swathKm: number): GroundTrackDescription | undefined {
  if (!isLeo(orbitalPeriodMin)) {
    return undefined;
  }
  return { widthMeters: swathKm * 1000 };
}

export interface ConeDescription {
  radiusMeters: number;
  innerHalfAngleRad: number;
  outerHalfAngleRad: number;
}

export function coneDescription(orbitalPeriodMin: number, fovDeg: number): ConeDescription | undefined {
  if (!isLeo(orbitalPeriodMin)) {
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

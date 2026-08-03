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

/** Bounds on how often time-dependent geometry is re-cut, in simulation seconds. */
export const GEOMETRY_REFRESH_MIN_SECONDS = 1;
export const GEOMETRY_REFRESH_MAX_SECONDS = 10;

/**
 * How often to re-cut the geometry that goes stale as the clock runs, given how
 * many satellites are drawing it. Shared by the batched orbit tracks and the
 * ground-track corridors, which have the same shape of problem.
 *
 * Neither is a rigid transform of itself as time passes — a fixed-frame track
 * and an Earth-relative swath both have to be rebuilt rather than re-oriented —
 * so the satellite runs on past the head of its own geometry until the next
 * rebuild, at roughly 7.5 km a second in LEO. The interval is therefore an error
 * budget, and the reason it is not simply "every frame" is that rebuilding is
 * what used to cost 342 ms and 414 ms of main thread respectively at five
 * thousand satellites.
 *
 * It scales with the count because both the error and the cost do, in opposite
 * directions. A handful is a scene someone is looking closely at, and a second
 * of lag there is under 10 km — sub-pixel on a globe. Thousands is a scene where
 * any one of them is a few pixels in a thicket, and ten seconds of lag buys back
 * the frame: measured at five thousand orbit tracks, going from ten seconds to
 * three took the worst frame from 43 ms to 250 ms to close an error nobody was
 * in a position to see. The satellite the camera is actually tracking sidesteps
 * the question entirely — it gets an exact per-frame PathGraphic (see
 * `orbitUsesPathGraphic`).
 */
export function geometryRefreshSeconds(count: number): number {
  return Math.min(GEOMETRY_REFRESH_MAX_SECONDS, Math.max(GEOMETRY_REFRESH_MIN_SECONDS, count / 100));
}

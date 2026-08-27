// The satellite components a user can switch on independently. Kept here, free
// of Cesium, because both SatelliteManager (which renders them) and the URL
// codec (which resolves legacy hyphen-escaped names against this list) need it.
//
// Order is the order they appear in the toolbar.
// "Illumination arc" sits next to "Orbit" rather than replacing it: the plain
// orbit says where the satellite goes, the arc says what the sun is doing along
// the way, and someone comparing two constellations wants the first without
// paying for the second.
export const SATELLITE_COMPONENTS = ["Point", "Label", "Orbit", "Illumination arc", "Orbit track", "Ground track", "Sensor cone", "3D model"] as const;

/**
 * How big a satellite's point is drawn, as a name rather than a number.
 *
 * A choice, because the right answer depends on what is on screen and nothing in
 * the app can know that: 5 px is what keeps a full Starlink activation from
 * merging into a sheet that hides the globe, and it is far too small for the
 * two-orbit scenes the orbit lab exists to show. Three rungs rather than a slider
 * — the difference that matters is "part of a constellation" versus "a satellite I
 * am watching", and that is not a continuum anyone tunes.
 */
export const POINT_SIZES = ["small", "medium", "large"] as const;

export type PointSize = (typeof POINT_SIZES)[number];

export const POINT_PIXEL_SIZE: Record<PointSize, number> = {
  small: 5,
  medium: 9,
  large: 14,
};

export const POINT_SIZE_LABEL: Record<PointSize, string> = {
  small: "Small — 5 px",
  medium: "Medium — 9 px",
  large: "Large — 14 px",
};

/**
 * How far a label sits from the point it names, given that point's size.
 *
 * Derived rather than fixed at 10 px: a 14 px point has a 7 px radius, so a label
 * 10 px out starts inside the marker it is labelling. Six pixels of gap past the
 * edge keeps the two readable as two things at every size.
 */
export function labelOffsetFor(size: PointSize): number {
  return Math.round(POINT_PIXEL_SIZE[size] / 2) + 6;
}

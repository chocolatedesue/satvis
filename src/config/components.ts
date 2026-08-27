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

// The orbit regime vocabulary, and the one colour each regime is drawn in.
//
// Kept here, free of Cesium, for the same reason src/config/viewModes.ts is: the
// element-set parser derives it, the globe draws by it and the satellite browser
// labels by it, and none of those three should own the list. The derivation
// itself lives next to the element set it reads, in `orbitClassOf`
// (src/modules/util/gp.ts).

/**
 * The orbit's regime, derived from the element set and never configured, so
 * every satellite has one and it cannot contradict the orbit it describes.
 *
 * "LEO" is exactly the band the ground-track and sensor-cone visuals gate on
 * (`isLeo` in src/modules/satelliteGraphics.ts) — one definition, not two.
 */
export type OrbitClass = "LEO" | "MEO" | "GEO" | "HEO";

/**
 * The colour a satellite of this class is drawn in, as CSS hex so both surfaces
 * can read it — the globe converts with `Color.fromCssColorString`, the browser
 * row uses it as a text colour directly. One table, so the badge in the menu and
 * the point on the globe cannot drift apart and the menu doubles as the legend.
 *
 * LEO takes the browser panel's own secondary text colour rather than a hue of
 * its own. It is the great majority of the catalog, so a saturated LEO would
 * decide the globe's entire character; and in the panel a badge brighter than
 * the satellite name beside it would invert the reading order. The other three
 * are Okabe-Ito hues, which stay distinguishable from each other and from the
 * neutral under deuteranopia and protanopia alike.
 */
export const ORBIT_CLASS_COLOR: Record<OrbitClass, string> = {
  LEO: "#b8c4c4",
  MEO: "#56b4e9",
  GEO: "#e69f00",
  HEO: "#cc79a7",
};

// The orbit regime vocabulary.
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

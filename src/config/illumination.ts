// The illumination vocabulary: what "lit" resolves into once the solar panel is
// part of the question, and the one colour each answer is drawn in.
//
// Kept here, free of Cesium and of satellite.js, for the same reason
// src/config/orbitClass.ts is: the physics derives a state
// (src/modules/util/illumination.ts), the globe draws by it and the orbit-lab
// panel legends by it, and none of the three should own the list.

/**
 * What the sun is doing to one satellite at one instant.
 *
 * Two independent facts are folded into one enum on purpose, because what a
 * reader wants to know is *why* there is no power, and that has three different
 * answers:
 *
 * - `umbra` / `penumbra` — geometric eclipse. No sunlight reaches the satellite
 *   at all (umbra), or the Earth covers part of the sun's disc (penumbra). This
 *   is the `ν` channel.
 * - `sunlit_back` / `sunlit_edge` / `sunlit_on` — full sunlight, and the panel
 *   either faces away from it (back), grazes it (edge) or receives it (on).
 *   This is the `κ` channel.
 *
 * `sunlit_back` is the state this vocabulary exists for: eclipse alone reports
 * it as "lit", and the satellite still has no power. Collapsing it into
 * "no light" would lose the distinction the analysis is about.
 */
export type IlluminationState = "umbra" | "penumbra" | "sunlit_back" | "sunlit_edge" | "sunlit_on";

/** In the order a legend reads them: darkest and most starved first. */
export const ILLUMINATION_STATES: readonly IlluminationState[] = ["umbra", "penumbra", "sunlit_back", "sunlit_edge", "sunlit_on"] as const;

/**
 * The colour a satellite in this state is drawn in, as CSS hex so both surfaces
 * can read it — the globe converts with `Color.fromCssColorString`, the panel's
 * legend uses it as a text colour directly. One table, so the legend in the menu
 * and the point on the globe cannot drift apart.
 *
 * Okabe-Ito hues, chosen so the two eclipse states and the three panel states
 * stay separable under deuteranopia and protanopia: yellow reads as "full
 * power", the two warm hues as the two ways a lit panel still fails, blue as
 * partial eclipse. `umbra` is a dark neutral rather than black — a black point
 * against the night side of the globe is not a point, and the existing
 * `Color.DIMGREY` outline is what keeps it findable at all.
 */
export const ILLUMINATION_COLOR: Record<IlluminationState, string> = {
  umbra: "#3f3f46",
  penumbra: "#0072b2",
  sunlit_back: "#d55e00",
  sunlit_edge: "#e69f00",
  sunlit_on: "#f0e442",
};

/** What each state means, for the legend's tooltip. One sentence each. */
export const ILLUMINATION_DESCRIPTION: Record<IlluminationState, string> = {
  umbra: "Full eclipse — the Earth covers the whole solar disc (ν = 0).",
  penumbra: "Partial eclipse — the Earth covers part of the solar disc (0 < ν < 1).",
  sunlit_back: "Sunlit, but the panel faces away from the sun (κ < 0) — no power despite the light.",
  sunlit_edge: "Sunlit, panel nearly edge-on to the sun (κ ≈ 0) — grazing incidence.",
  sunlit_on: "Sunlit with the panel facing the sun (κ > 0).",
};

/**
 * Where the solar panel's normal points, in the satellite's own orbital frame.
 *
 * A model choice, not a fact about any real spacecraft: nothing in a GP element
 * set says anything about attitude, so κ cannot be derived, only assumed. Making
 * the assumption selectable is what keeps it honest — the readout names the axis
 * it used, and a reader can see how much of the answer the assumption decides.
 *
 * - `zenith` — body-fixed panel on the anti-Earth face of a nadir-pointing bus.
 *   The default, and the only one of the three that puts the panel through a
 *   full sign change over an orbit, which is what makes `sunlit_back` a state
 *   the timeline actually visits.
 * - `velocity` — panel normal along the flight direction.
 * - `normal` — panel normal along the orbit normal (r × v). Nearly constant over
 *   an orbit, so κ then reports the sun's elevation above the orbital plane (the
 *   beta angle) rather than anything that varies within one revolution.
 */
export type PanelAxis = "zenith" | "velocity" | "normal";

export const PANEL_AXES: readonly PanelAxis[] = ["zenith", "velocity", "normal"] as const;

export const PANEL_AXIS_LABEL: Record<PanelAxis, string> = {
  zenith: "Zenith (anti-nadir)",
  velocity: "Velocity",
  normal: "Orbit normal",
};

/**
 * How a satellite's point is coloured.
 *
 * Two modes rather than a sixth orbit class, because the two answer different
 * questions about the same satellite and both are worth having: `class` is a
 * standing fact about the orbit, `illumination` is what the sun is doing to it
 * right now. Only `illumination` costs a per-frame evaluation, which is why the
 * default is not it.
 */
export type PointColorMode = "class" | "illumination";

export const POINT_COLOR_MODES: readonly PointColorMode[] = ["class", "illumination"] as const;

export const POINT_COLOR_MODE_LABEL: Record<PointColorMode, string> = {
  class: "Orbit class",
  illumination: "Illumination",
};

/**
 * How points are currently painted, as one value.
 *
 * The two fields travel together because neither answers the question alone: a
 * panel axis says nothing unless the illumination mode is on, and the mode is not
 * a colour until the axis picks one. Held by the SatelliteManager and handed to
 * each satellite by reference, the same way the shared polyline batches are — so
 * a satellite created after a change reads the same settings as one created
 * before it, and nothing has to be told twice.
 */
export interface PointPaint {
  mode: PointColorMode;
  panelAxis: PanelAxis;
}

export const DEFAULT_POINT_PAINT: PointPaint = { mode: "class", panelAxis: "zenith" };

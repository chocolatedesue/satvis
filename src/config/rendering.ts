// Rendering quality choices that are neither a view mode nor a layer.

/**
 * Multisample antialiasing rates the menu offers, in the order it offers them.
 *
 * Three values rather than a switch because the middle one is real: measured on
 * an M4 Pro at 2552x3152 with an empty globe, the frame cost is close to linear
 * in the sample count — 15.1 ms at 1x, 22.1 ms at 2x, 28.8 ms at 4x — so 2x buys
 * back half of what antialiasing costs rather than all or nothing.
 *
 * `4` is Cesium's own default and what the globe was built and looked at with.
 * Higher rates are not offered: a WebGL2 context caps `maximumSamples`, which is
 * 4 on ANGLE/Metal, and Cesium clamps to it silently — an `8x` entry would have
 * cost exactly what `4x` costs and looked identical.
 */
export const MSAA_RATES = ["off", "2", "4"] as const;

export type MsaaRate = (typeof MSAA_RATES)[number];

/** The sample count a rate asks the scene for. `1` is how Cesium spells "off". */
export function msaaSamplesFor(rate: string): number {
  return rate === "off" ? 1 : Number(rate);
}

/**
 * Drawing-buffer pixels per CSS pixel, along one axis. `native` is the display's
 * own ratio, which is what a globe should be drawn at; the fixed values below it
 * trade sharpness for fill rate.
 *
 * This replaced a `low`/`high` switch that could only choose between 1 and the
 * display's ratio. Two reasons for the ladder: the cost is quadratic in this
 * number — on a DPR-2 display an empty globe is 29.6 ms at native and 9.8 ms at
 * 1, so the interesting settings are all in between — and the endpoints answer
 * the wrong question on a phone, where `native` is 3 and the fallback is a
 * quarter-resolution blur.
 */
export const PIXEL_RATIOS = ["1", "1.25", "1.5", "1.75", "native"] as const;

export type PixelRatio = (typeof PIXEL_RATIOS)[number];

/**
 * What to set `viewer.resolutionScale` to for a chosen ratio.
 *
 * Cesium multiplies `resolutionScale` by the device ratio (`useBrowserRecommendedResolution`
 * being false is what selects that rather than a flat 1.0), so asking for an
 * absolute ratio means dividing the target by the display's own.
 */
export function resolutionScaleFor(ratio: string, devicePixelRatio: number): number {
  if (ratio === "native" || devicePixelRatio <= 0) {
    return 1;
  }
  return Number(ratio) / devicePixelRatio;
}

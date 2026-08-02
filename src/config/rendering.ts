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
 * Where a display stops needing multisampling. At or above this many device
 * pixels per css pixel the globe's silhouette is already oversampled, and MSAA
 * is paying full price for an edge nobody can see stepping.
 */
export const HIDPI_THRESHOLD = 2;

/**
 * The MSAA rate a display should start at.
 *
 * MSAA turns out to touch almost nothing in this app. Measured pixel-for-pixel
 * against the same frozen scene, 4x and off are **byte-identical** on label
 * text and on orbit lines — labels are sdf glyph quads and Cesium's polylines
 * antialias analytically in their own fragment shader, so neither sees a
 * multisample buffer. The only thing that changes is the globe's limb: 0.044%
 * of the frame at ratio 2, 0.109% at ratio 1.
 *
 * Its price is the opposite shape. MSAA costs per pixel, so it grows with the
 * ratio exactly as its benefit shrinks. With 74 satellites drawn at ratio 2,
 * 4x costs 13.3 ms of a 30.4 ms frame for that 0.044%; at ratio 1, 2x costs
 * 1.1 ms over off — nearly free, at the resolution where the limb actually
 * steps.
 *
 * Hence off above the threshold and 2x below it, and hence `pixelRatio` is
 * *not* conditional on anything: it is the one setting that degrades label
 * text, so it stays at `native` and MSAA is what gives way. Dropping the ratio
 * instead is worse on both counts — at 74 satellites `1.5x + 4x` costs 18.8 ms
 * against 17.1 ms for `native + off`, and blurs every label to buy it.
 */
export function defaultMsaaRate(devicePixelRatio: number): MsaaRate {
  return devicePixelRatio >= HIDPI_THRESHOLD ? "off" : "2";
}

/**
 * The display's ratio, or 1 where there is no display.
 *
 * The store is constructed under vitest's node environment as well as in a
 * browser, and a bare `window.devicePixelRatio` at setup throws there. Falling
 * back to 1 rather than to the hidpi branch keeps the headless default on the
 * conservative side — antialiasing on — and keeps `defaultMsaaRate` itself pure
 * and drivable from a test.
 */
export function currentDevicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio;
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

import { describe, expect, test } from "vitest";

import { MSAA_RATES, PIXEL_RATIOS, currentDevicePixelRatio, defaultMsaaRate, msaaSamplesFor, resolutionScaleFor } from "./rendering";

describe("msaaSamplesFor", () => {
  test("off is one sample, which is how Cesium spells it", () => {
    expect(msaaSamplesFor("off")).toBe(1);
  });

  test("a rate is its own sample count", () => {
    expect(msaaSamplesFor("2")).toBe(2);
    expect(msaaSamplesFor("4")).toBe(4);
  });

  test("every offered rate maps to a usable sample count", () => {
    for (const rate of MSAA_RATES) {
      const samples = msaaSamplesFor(rate);
      expect(Number.isInteger(samples)).toBe(true);
      expect(samples).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("resolutionScaleFor", () => {
  test("native leaves Cesium's own multiplication alone", () => {
    expect(resolutionScaleFor("native", 2)).toBe(1);
    expect(resolutionScaleFor("native", 3)).toBe(1);
  });

  test("a fixed ratio divides out the display's own", () => {
    expect(resolutionScaleFor("1", 2)).toBe(0.5);
    expect(resolutionScaleFor("1.5", 2)).toBe(0.75);
    expect(resolutionScaleFor("1", 1)).toBe(1);
    expect(resolutionScaleFor("1.5", 3)).toBe(0.5);
  });

  test("asking for more than the display has supersamples rather than clamping", () => {
    expect(resolutionScaleFor("1.5", 1)).toBe(1.5);
  });

  test("a nonsense device ratio falls back to native rather than dividing by zero", () => {
    expect(resolutionScaleFor("1.5", 0)).toBe(1);
    expect(resolutionScaleFor("1.5", -1)).toBe(1);
  });

  test("every offered ratio yields a positive finite scale", () => {
    for (const ratio of PIXEL_RATIOS) {
      const scale = resolutionScaleFor(ratio, 2);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });
});

describe("defaultMsaaRate", () => {
  test("a hidpi display starts with no multisampling", () => {
    expect(defaultMsaaRate(2)).toBe("off");
    expect(defaultMsaaRate(3)).toBe("off");
  });

  test("a display at or below css resolution keeps 2x, where the limb still steps", () => {
    expect(defaultMsaaRate(1)).toBe("2");
    expect(defaultMsaaRate(1.5)).toBe("2");
  });

  test("the default is always one of the rates the menu offers", () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.625, 3, 4]) {
      expect(MSAA_RATES).toContain(defaultMsaaRate(dpr));
    }
  });

  test("4x is never a default — it is only ever an explicit choice", () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      expect(defaultMsaaRate(dpr)).not.toBe("4");
    }
  });
});

describe("currentDevicePixelRatio", () => {
  // The store reads this at setup, and setup happens under vitest's node
  // environment too — where a bare `window` throws and took ten sceneSync
  // tests down with it.
  test("answers 1 with no window rather than throwing", () => {
    expect(globalThis.window).toBeUndefined();
    expect(currentDevicePixelRatio()).toBe(1);
  });

  test("the headless default keeps antialiasing on", () => {
    expect(defaultMsaaRate(currentDevicePixelRatio())).toBe("2");
  });
});

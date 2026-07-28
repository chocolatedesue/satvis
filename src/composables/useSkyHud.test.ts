import { Math as CesiumMath } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { fovxFromFovy, MAX_FOVY, MIN_FOVY } from "../modules/SkyView";
import { majorStep, stepFor, TICKS_WANTED } from "./useSkyHud";

/** The horizontal angle a viewport of this shape spans at this zoom. */
const span = (fovy: number, width: number, height: number): number => CesiumMath.toDegrees(fovxFromFovy(CesiumMath.toRadians(fovy), width / height));

const PHONE = [390, 844] as const;
const DESKTOP = [1600, 900] as const;

describe("stepFor", () => {
  test("leaves a landscape desktop at the default zoom where it always was", () => {
    expect(stepFor(span(75, ...DESKTOP))).toBe(15);
  });

  test("goes finer on a portrait phone, whose span is a third of that", () => {
    // ~39° across, where a 15° step yields two or three marks and the 45°-spaced
    // cardinal label is often off screen entirely.
    expect(Math.round(span(75, ...PHONE))).toBe(39);
    expect(stepFor(span(75, ...PHONE))).toBe(5);
  });

  test("keeps the tape populated at maximum zoom, which is what fixed steps did not", () => {
    // ~4.6° across on a phone: every rung but the finest leaves the nearest mark
    // off screen, which is how the tape used to go blank.
    expect(stepFor(span(MIN_FOVY, ...PHONE))).toBe(1);
    expect(stepFor(span(MIN_FOVY, ...DESKTOP))).toBe(5);
  });

  test("stays between three and nine marks across the whole zoom range", () => {
    // The upper bound is what the ladder's spacing buys: no rung is more than
    // three times the next, so the count cannot exceed three times the minimum.
    for (const [width, height] of [PHONE, DESKTOP, [1000, 1000] as const]) {
      for (let fovy = MIN_FOVY; fovy <= MAX_FOVY; fovy += 0.5) {
        const across = span(fovy, width, height);
        const label = `${width}x${height} at ${fovy}°`;
        expect(across / stepFor(across), label).toBeGreaterThanOrEqual(TICKS_WANTED);
        expect(across / stepFor(across), label).toBeLessThan(TICKS_WANTED * 3);
      }
    }
  });
});

describe("majorStep", () => {
  test("keeps the compass points among the majors at every rung", () => {
    // The label rule depends on this: a major spacing that did not divide 45 would
    // drop N/E/S/W off the tape.
    for (const step of [45, 15, 5, 3, 1]) {
      expect(45 % majorStep(step), `step ${step}`).toBe(0);
    }
  });

  test("labels every tick when the step is already 45", () => {
    expect(majorStep(45)).toBe(45);
  });

  test("labels every third tick otherwise", () => {
    expect(majorStep(15)).toBe(45);
    expect(majorStep(5)).toBe(15);
    expect(majorStep(1)).toBe(3);
  });
});

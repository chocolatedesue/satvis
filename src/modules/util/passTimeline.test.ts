import { describe, expect, test } from "vitest";

import type { Pass } from "../PassPredictor";
import { passBand, passTimelineLayout } from "./passTimeline";

const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function pass(startOffsetMs: number, lengthMs = 10 * MIN, maxElevation = 40): Pass {
  return {
    name: "ISS",
    start: T0 + startOffsetMs,
    end: T0 + startOffsetMs + lengthMs,
    duration: lengthMs,
    azimuthStart: 10,
    azimuthApex: 180,
    azimuthEnd: 200,
    maxElevation,
    groundStationName: "Munich",
  };
}

describe("passBand", () => {
  test("splits at the elevations worth distinguishing", () => {
    // 0.5 and 0.222 of full quality are 45 and 20 degrees.
    expect(passBand(45 / 90)).toBe("high");
    expect(passBand(44 / 90)).toBe("mid");
    expect(passBand(20 / 90)).toBe("mid");
    expect(passBand(19 / 90)).toBe("low");
  });
});

describe("passTimelineLayout", () => {
  test("sizes the horizon to the passes rather than to a fixed window", () => {
    // Six passes an hour apart need about six hours; six a day apart need days.
    const tight = passTimelineLayout(
      [1, 2, 3, 4, 5, 6].map((h) => pass(h * HOUR)),
      T0,
    );
    const sparse = passTimelineLayout(
      [1, 2, 3, 4, 5, 6].map((d) => pass(d * 24 * HOUR)),
      T0,
    );
    // 7 h, not 6: the last block gets a tenth of headroom so it is not flush
    // with the right edge.
    expect(tight.horizonLabel).toBe("7 h");
    expect(tight.blocks).toHaveLength(6);
    // A satellite with one pass a day cannot fit six inside the 48 h ceiling. The
    // strip shows what it can and the caption accounts for the rest. That is the
    // clamp working, not the sizing failing.
    expect(sparse.horizonLabel).toBe("2 d");
    expect(sparse.blocks).toHaveLength(2);
    expect(sparse.beyond).toBe(4);
  });

  test("clamps the horizon rather than following one distant pass anywhere", () => {
    const far = passTimelineLayout([pass(300 * 24 * HOUR)], T0);
    expect(far.horizonLabel).toBe("2 d");
    expect(far.blocks).toHaveLength(0);
    expect(far.beyond).toBe(1);
  });

  test("an empty list still lays out, at the minimum span", () => {
    const empty = passTimelineLayout([], T0);
    expect(empty.blocks).toEqual([]);
    expect(empty.horizonLabel).toBe("6 h");
    expect(empty.beyond).toBe(0);
  });

  test("now sits inside the strip, so its marker is a line on the track", () => {
    const layout = passTimelineLayout([pass(1 * HOUR)], T0);
    expect(layout.nowPct).toBeGreaterThan(0);
    expect(layout.nowPct).toBeLessThan(15);
  });

  test("marks the pass happening now, and dims the one that has ended", () => {
    const layout = passTimelineLayout([pass(-5 * MIN), pass(-25 * MIN, 5 * MIN), pass(1 * HOUR)], T0);
    expect(layout.blocks.map((block) => [block.live, block.past])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  test("gives a short pass a hittable width and a grazing one a visible height", () => {
    const layout = passTimelineLayout([pass(1 * HOUR, 30 * 1000, 1)], T0);
    expect(layout.blocks[0]!.widthPct).toBeGreaterThanOrEqual(1.2);
    expect(layout.blocks[0]!.heightPct).toBeGreaterThan(20);
  });

  test("keeps every tick label clear of the right edge", () => {
    const layout = passTimelineLayout(
      [1, 2, 3, 4, 5, 6].map((h) => pass(h * HOUR)),
      T0,
    );
    expect(layout.ticks.length).toBeGreaterThan(0);
    expect(Math.max(...layout.ticks.map((tick) => tick.pct))).toBeLessThanOrEqual(90);
  });

  test("keys blocks by start time, so nothing has to stay index-aligned", () => {
    const layout = passTimelineLayout([pass(1 * HOUR), pass(2 * HOUR)], T0);
    expect(layout.blocks.map((block) => block.key)).toEqual([String(T0 + HOUR), String(T0 + 2 * HOUR)]);
  });
});

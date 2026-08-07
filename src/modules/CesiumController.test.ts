import type { CesiumWidget } from "@cesium/engine";
import { describe, expect, it } from "vitest";

import { skipUnsizedFrames } from "./CesiumController";

/**
 * A fake widget that counts renders and ticks. The `render` of Cesium ticks the
 * clock itself, so the guard must keep the tick count equal after a skip.
 */
function fakeWidget(width: number, height: number) {
  const state = { renders: 0, ticks: 0, width, height };

  const widget = {
    scene: {
      get drawingBufferWidth() {
        return state.width;
      },
      get drawingBufferHeight() {
        return state.height;
      },
    },
    clock: {
      tick() {
        state.ticks += 1;
      },
    },
    render() {
      state.renders += 1;
      state.ticks += 1;
    },
  };

  return { widget: widget as unknown as CesiumWidget, state };
}

describe("skipUnsizedFrames", () => {
  it("draws when the drawing buffer has a size", () => {
    const { widget, state } = fakeWidget(1110, 500);
    skipUnsizedFrames(widget);

    widget.render();

    expect(state.renders).toBe(1);
  });

  it.each([
    ["zero width", 0, 500],
    ["zero height", 1110, 0],
    ["zero both", 0, 0],
  ])("skips the frame on %s", (_case, width, height) => {
    const { widget, state } = fakeWidget(width, height);
    skipUnsizedFrames(widget);

    widget.render();

    expect(state.renders).toBe(0);
  });

  it("ticks the clock while it skips, so the clock stays current", () => {
    const { widget, state } = fakeWidget(0, 0);
    skipUnsizedFrames(widget);

    widget.render();
    widget.render();

    expect(state.ticks).toBe(2);
  });

  it("draws again after the canvas has a size, and does not stay off", () => {
    const { widget, state } = fakeWidget(0, 0);
    skipUnsizedFrames(widget);

    widget.render();
    state.width = 1110;
    state.height = 500;
    widget.render();

    expect(state.renders).toBe(1);
    expect(state.ticks).toBe(2);
  });
});

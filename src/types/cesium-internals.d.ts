// Augmentations for Cesium widget internals that are used at runtime but not
// exposed in the published `.d.ts`. Restricting these to a single declaration
// file keeps the rest of the codebase honest about what's "real" Cesium API.

import type { Color, JulianDate } from "@cesium/engine";

interface TimelineHighlightRange {
  setRange(start: JulianDate, end: JulianDate): void;
}

declare module "@cesium/widgets" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Timeline {
    updateFromClock(): void;
    addHighlightRange(color: Color, heightInPx: number, baseInPx: number): TimelineHighlightRange;
    _highlightRanges: TimelineHighlightRange[];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Viewer {
    _animation: { container: HTMLElement };
    _timeline: { container: HTMLElement };
    _fullscreenButton: { _container: HTMLElement };
    /** Container holding the Cesium credit and bottom UI. */
    _bottomContainer: HTMLElement;
  }
}

declare module "@cesium/engine" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Scene {
    /** Drives the component visibility updates. */
    frameState: unknown;
  }
}

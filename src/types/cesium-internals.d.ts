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
    /** Refresh the timeline rendering against the current clock state. */
    updateFromClock(): void;
    /** Add a colored highlight range to the timeline. */
    addHighlightRange(color: Color, heightInPx: number, baseInPx: number): TimelineHighlightRange;
    /** Internal array of active highlight ranges. */
    _highlightRanges: TimelineHighlightRange[];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Viewer {
    /** Animation widget container (DOM-mounted, underscore-prefixed). */
    _animation: { container: HTMLElement };
    /** Timeline widget container. */
    _timeline: { container: HTMLElement };
    /** Fullscreen toggle button widget. */
    _fullscreenButton: { _container: HTMLElement };
    /** Container holding the Cesium credit and bottom UI. */
    _bottomContainer: HTMLElement;
  }
}

declare module "@cesium/engine" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Scene {
    /** Current frame state (used to drive component visibility updates). */
    frameState: unknown;
  }
}

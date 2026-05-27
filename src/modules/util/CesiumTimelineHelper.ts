import { Color, JulianDate } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

export interface TimelineRange {
  start: string | number | Date;
  end: string | number | Date;
}

export class CesiumTimelineHelper {
  static clearHighlightRanges(viewer: Viewer): void {
    if (!viewer.timeline || viewer.timeline._highlightRanges.length === 0) {
      return;
    }

    viewer.timeline._highlightRanges = [];
    viewer.timeline.updateFromClock();
    viewer.timeline.zoomTo(viewer.clock.startTime, viewer.clock.stopTime);
  }

  static addHighlightRanges(viewer: Viewer, ranges: TimelineRange[]): void {
    if (!viewer.timeline) {
      return;
    }
    ranges.forEach((range) => {
      const startJulian = JulianDate.fromDate(new Date(range.start));
      const endJulian = JulianDate.fromDate(new Date(range.end));
      const highlightRange = viewer.timeline.addHighlightRange(Color.BLUE, 100, 0);
      highlightRange.setRange(startJulian, endJulian);
      viewer.timeline.updateFromClock();
      viewer.timeline.zoomTo(viewer.clock.startTime, viewer.clock.stopTime);
    });
  }

  static updateHighlightRanges(viewer: Viewer, ranges: TimelineRange[]): void {
    this.clearHighlightRanges(viewer);
    this.addHighlightRanges(viewer, ranges);
  }
}

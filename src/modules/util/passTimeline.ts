// Laying out a pass list as a strip: where each pass sits along a horizon, how
// tall it is drawn, and where the hour marks and "now" fall.
//
// Pure and Cesium-free, because it is the part worth testing — the component that
// consumes it does nothing but turn percentages into inline styles.

import { passQuality, type Pass } from "../PassPredictor";

const HOUR_MS = 3600 * 1000;

/**
 * A little track before now, so the "now" marker is a line *on* the strip rather
 * than on its edge. A pass that has just ended stays visible too.
 */
const LEAD_IN_MS = 30 * 60 * 1000;

/**
 * How many passes the strip tries to cover, and the window it may not leave.
 *
 * A fixed span was measured empty. The ISS clumps into a morning and an evening
 * group. At 20:30 UTC only two of its twenty-three passes fell inside twelve hours,
 * while the table below listed all twenty-three. Sizing the span to the passes
 * keeps the strip populated for a clumper and a sun-synchronous regular alike.
 */
const TARGET_BLOCKS = 6;
const MIN_SPAN_MS = 6 * HOUR_MS;
const MAX_SPAN_MS = 48 * HOUR_MS;

/** Bands a pass is drawn in. Three, because three is what a legend can explain. */
export type PassBand = "high" | "mid" | "low";

/**
 * Thresholds on `passQuality`. 0.5 and 0.222 are 45° and 20° of elevation, the
 * points either side of "worth going outside for". In swath mode they are the same
 * fractions of the way from the footprint edge to its centre.
 */
export function passBand(quality: number): PassBand {
  if (quality >= 0.5) {
    return "high";
  }
  return quality >= 0.222 ? "mid" : "low";
}

export interface TimelineBlock {
  key: string;
  startMs: number;
  /** Percentages across the strip, ready for `left`/`width`/`height`. */
  leftPct: number;
  widthPct: number;
  heightPct: number;
  band: PassBand;
  /** Happening now, which the strip draws differently from one merely upcoming. */
  live: boolean;
  past: boolean;
}

export interface TimelineTick {
  label: string;
  pct: number;
}

export interface TimelineLayout {
  blocks: TimelineBlock[];
  ticks: TimelineTick[];
  /** Where "now" falls, which is `LEAD_IN_MS` in rather than at the left edge. */
  nowPct: number;
  /** How far the strip reaches, for the caption: "7 h", "1.5 d". */
  horizonLabel: string;
  /** Passes that start beyond the strip, so their absence can be accounted for. */
  beyond: number;
}

/**
 * Lay out the passes that fall inside an automatically sized horizon.
 *
 * `passes` is the same list the table shows, in the same order. Blocks come back
 * keyed by start time. A caller can then match a block to a row without either side
 * assuming the two arrays stay index-aligned.
 */
export function passTimelineLayout(passes: readonly Pass[], nowMs: number): TimelineLayout {
  const horizonMs = horizonFor(passes, nowMs);
  const spanStart = nowMs - LEAD_IN_MS;
  const spanEnd = nowMs + horizonMs;
  const spanMs = LEAD_IN_MS + horizonMs;
  const pct = (epochMs: number): number => ((epochMs - spanStart) / spanMs) * 100;

  const blocks = passes
    .filter((pass) => pass.end >= spanStart && pass.start <= spanEnd)
    .map((pass) => {
      const left = pct(Math.max(spanStart, pass.start));
      return {
        key: String(pass.start),
        startMs: pass.start,
        leftPct: left,
        // Floored, so a nine-minute pass on a two-day strip is still a hittable target.
        widthPct: Math.max(1.2, pct(Math.min(spanEnd, pass.end)) - left),
        // Never zero-height: a grazing pass still happened.
        heightPct: 25 + passQuality(pass) * 75,
        band: passBand(passQuality(pass)),
        live: pass.start <= nowMs && pass.end >= nowMs,
        past: pass.end < nowMs,
      };
    });

  return {
    blocks,
    ticks: ticksFor(horizonMs, nowMs, pct),
    nowPct: pct(nowMs),
    horizonLabel: horizonLabel(horizonMs),
    beyond: passes.filter((pass) => pass.start > spanEnd).length,
  };
}

/** Enough span to hold `TARGET_BLOCKS` passes, clamped so neither extreme is absurd. */
function horizonFor(passes: readonly Pass[], nowMs: number): number {
  const upcoming = passes.filter((pass) => pass.end >= nowMs);
  const last = upcoming[Math.min(TARGET_BLOCKS, upcoming.length) - 1];
  if (!last) {
    return MIN_SPAN_MS;
  }
  // A tenth of headroom past the last block, so it is not flush with the edge.
  return Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, (last.end - nowMs) * 1.1));
}

/** Roughly four marks, on a step a human reads in hours. */
function ticksFor(horizonMs: number, nowMs: number, pct: (epochMs: number) => number): TimelineTick[] {
  const hours = horizonMs / HOUR_MS;
  const step = [1, 2, 3, 6, 12, 24].find((candidate) => hours / candidate <= 5) ?? 24;
  const ticks: TimelineTick[] = [];
  for (let hour = step; hour < hours; hour += step) {
    const at = pct(nowMs + hour * HOUR_MS);
    // Past 90% the label runs off the right edge of the strip.
    if (at > 90) {
      break;
    }
    ticks.push({ label: `+${hour}h`, pct: at });
  }
  return ticks;
}

function horizonLabel(horizonMs: number): string {
  const hours = horizonMs / HOUR_MS;
  return hours >= 24 ? `${(hours / 24).toFixed(hours % 24 === 0 ? 0 : 1)} d` : `${Math.round(hours)} h`;
}

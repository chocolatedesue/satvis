// The energy trace: what a scheduler simulator consumes, rather than what a reader
// reads.
//
// ./energyStatistics.ts aggregates into fractions and spreads. A migration algorithm
// does not want a fraction — it wants the instants: when does this satellite lose
// power, for how long, and how much warning was there. Those are intervals, and this
// file extracts them.
//
// The slot convention matches the one the migration model in LAB-47 uses (Δ = 10 s),
// so a trace from here drops into that model's `ℓ_i(t)` without resampling.

import type { SatRec } from "satellite.js";

import type { IlluminationState, PanelAxis } from "../../config/illumination";
import { isDark, isEclipsed } from "./energyStatistics";
import { illuminationAt } from "./illumination";

/** The slot length the migration model discretises time into. */
export const SLOT_SECONDS = 10;

export interface DarkInterval {
  /** Milliseconds since the epoch at the first slot with no usable power. */
  startMs: number;
  /** Milliseconds at the first slot with power again. */
  endMs: number;
  seconds: number;
  /** How long the satellite had power before this interval began, in seconds. */
  leadSeconds: number;
  /** Whether the Earth was in the way, or only the panel. */
  cause: "eclipse" | "panel";
  /** True when the interval was still running when the window ended. */
  truncated: boolean;
}

/**
 * Every interval in which a satellite has no usable power, with the warning it had.
 *
 * `leadSeconds` is the number a migration algorithm actually plans against: how long the
 * host had power before this interval, and therefore the notice it could have given.
 * Measured from the end of the previous dark interval — measuring it from the previous
 * *slot* makes every lead one slot long, which is what the first version of this
 * reported and what the churn table then published. The first interval's lead is
 * measured from the start of the window, so it is a lower bound; callers that care
 * should start a full orbit early and discard it.
 *
 * Intervals still running at the end of the window are returned with `truncated`, not
 * dropped: silently losing the interval that overruns the horizon is how a simulator
 * comes to believe the last orbit of its run is sunnier than the rest.
 */
export function darkIntervals(satrec: SatRec, start: Date, durationSeconds: number, axis: PanelAxis, stepSeconds = SLOT_SECONDS): DarkInterval[] {
  const intervals: DarkInterval[] = [];
  let openedAtMs: number | undefined;
  let openedCause: "eclipse" | "panel" = "eclipse";
  // When the *current lit stretch* began, not the last lit slot: the lead time is how
  // long the host had power, and measuring it from the previous slot makes every lead
  // exactly one slot — which is what the first version of this reported.
  let litSinceMs = start.getTime();

  for (let offset = 0; offset <= durationSeconds; offset += stepSeconds) {
    const at = new Date(start.getTime() + offset * 1000);
    const state: IlluminationState | undefined = illuminationAt(satrec, at, axis)?.state;
    if (!state) {
      continue;
    }
    if (isDark(state)) {
      if (openedAtMs === undefined) {
        openedAtMs = at.getTime();
        // Whichever cause opened the interval names it: an eclipse that begins while
        // the panel already faced away is still an eclipse to a power budget, but the
        // interval started for the panel's reason.
        openedCause = isEclipsed(state) ? "eclipse" : "panel";
      }
    } else if (openedAtMs !== undefined) {
      intervals.push({
        startMs: openedAtMs,
        endMs: at.getTime(),
        seconds: (at.getTime() - openedAtMs) / 1000,
        leadSeconds: (openedAtMs - litSinceMs) / 1000,
        cause: openedCause,
        truncated: false,
      });
      openedAtMs = undefined;
      litSinceMs = at.getTime();
    }
  }

  if (openedAtMs !== undefined) {
    const endMs = start.getTime() + durationSeconds * 1000;
    intervals.push({
      startMs: openedAtMs,
      endMs,
      seconds: (endMs - openedAtMs) / 1000,
      leadSeconds: (openedAtMs - litSinceMs) / 1000,
      cause: openedCause,
      truncated: true,
    });
  }
  return intervals;
}

/**
 * The optimal pipeline depth for a ring of `N` satellites of which a fraction
 * `eclipseFraction` is dark at any moment.
 *
 * `P* = ⌊N · (1 − f_ecl)⌋`, from the migration model's own derivation: stages must
 * occupy a contiguous arc of the ring, so the arc cannot be longer than the lit arc.
 * Reproduced here — not re-derived — so that a per-plane eclipse fraction can be turned
 * into the per-plane pipeline depth it implies, which is the point of measuring the
 * fraction per plane rather than once for the shell.
 */
export function optimalPipelineDepth(satellitesPerPlane: number, eclipseFraction: number): number {
  return Math.floor(satellitesPerPlane * (1 - eclipseFraction));
}

/**
 * The share of time every stage of a `depth`-deep pipeline is simultaneously lit, for a
 * statically placed arc: `max(0, (1 − f_ecl) − (depth − 1)/N)`.
 *
 * Also the migration model's, and also reproduced rather than re-derived. It is the
 * quantity that collapses to zero once the pipeline is deeper than the lit arc, which
 * is what makes `P*` a cliff rather than a slope.
 */
export function fullyLitFraction(satellitesPerPlane: number, eclipseFraction: number, depth: number): number {
  return Math.max(0, 1 - eclipseFraction - (depth - 1) / satellitesPerPlane);
}

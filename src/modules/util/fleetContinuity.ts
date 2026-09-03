// Real-fleet service continuity, as a pure read-out over sampled power states.
//
// The migration overlay answers "what is the pipeline doing right now" from live
// geometry. This module answers the question a real operator asks *before* flying
// the workload: mapped onto a real catalogued constellation — Iridium, OneWeb,
// Starlink, whatever group is active — how much of the time could a k-stage
// pipeline actually serve?
//
// The input is deliberately dumb: one boolean per satellite per sampled instant,
// folded out of the same illumination model the globe paints (the caller samples
// each satellite's timeline over the same absolute window, so column i of every
// row is the same instant). Two derived figures matter, and they bracket what the
// migration machinery can buy:
//
// - **Static placement continuity** — a fixed mapping of stages onto satellites,
//   chosen once up front by greedy best-lit, is the "constellation as designed"
//   deployment: no handoffs, no routing, the pipeline serves only while its own
//   hosts all have power. On a real fleet this lands far below any single
//   satellite's lit fraction, because the conjunction over stages is the same
//   arithmetic the naive overlay demonstrates.
// - **Service opportunity** — the share of instants where at least k satellites
//   are lit simultaneously, whatever they are. That is the ceiling live migration
//   (predictive handoff, relay routing, incremental sync) can reach: you cannot
//   serve from hosts that do not exist, and with migration you never have to
//   settle for less than the lit set allows.
//
// What sits between the two numbers is what the overlay is worth on a real fleet.

/**
 * The continuity report for one fleet, over one sampled window.
 */
export interface FleetContinuity {
  /** Satellites sampled. */
  satellites: number;
  /** Sampled instants per satellite. */
  samples: number;
  /** Mean per-satellite sunlit fraction — the fleet's plain power geometry. */
  meanSunlitFraction: number;
  /** The best single satellite's sunlit fraction, for a one-stage pipeline. */
  bestSunlitFraction: number;
  /**
   * Share of instants where a fixed greedy placement of `stages` satellites is
   * fully lit at once. Undefined when the fleet cannot host the pipeline at all.
   */
  staticPlacementContinuity: number | undefined;
  /**
   * Share of instants where at least `stages` satellites are lit at once — the
   * ceiling a live-migrated pipeline can reach, whatever its placement.
   */
  serviceOpportunity: number;
  /** Input indices of the fixed placement, best-lit first. */
  placement: number[];
}

/**
 * Rank the fleet by its own sunlit fraction and take the `stages` best.
 *
 * Greedy on the per-satellite figure, because the fixed deployment a real
 * operator would pick is "put the stages where the sun lives" — the correlation
 * between satellites' eclipse phases is exactly what this placement cannot
 * exploit and what migration can. Ties keep input order, so the report is
 * deterministic for a fixed input.
 */
function greedyPlacement(powered: readonly (readonly boolean[])[], stages: number): number[] {
  const fractions = powered.map((row) => (row.length === 0 ? 0 : row.filter(Boolean).length / row.length));
  return fractions
    .map((fraction, index) => ({ fraction, index }))
    .toSorted((a, b) => b.fraction - a.fraction || a.index - b.index)
    .slice(0, stages)
    .map((entry) => entry.index);
}

/**
 * Evaluate the continuity figures over a sampled power matrix.
 *
 * `powered[satellite][instant]` — one row per satellite, one column per sampled
 * instant, true where the satellite can power its compute. Columns must mean the
 * same instants across rows; `stages` is the pipeline's length. An empty fleet or
 * an empty timeline answers a report of zeros rather than dividing by nothing.
 */
export function fleetContinuity(powered: readonly (readonly boolean[])[], stages: number): FleetContinuity {
  const satellites = powered.length;
  const samples = satellites > 0 ? (powered[0]?.length ?? 0) : 0;
  if (satellites === 0 || samples === 0) {
    return { satellites, samples, meanSunlitFraction: 0, bestSunlitFraction: 0, staticPlacementContinuity: undefined, serviceOpportunity: 0, placement: [] };
  }

  const fractions = powered.map((row) => row.filter(Boolean).length / samples);
  const meanSunlitFraction = fractions.reduce((sum, fraction) => sum + fraction, 0) / satellites;
  const bestSunlitFraction = Math.max(...fractions);

  const placement = greedyPlacement(powered, Math.max(1, Math.min(stages, satellites)));
  let placementLit = 0;
  let opportunity = 0;
  for (let at = 0; at < samples; at += 1) {
    const litNow = powered.reduce((count, row) => count + (row[at] ? 1 : 0), 0);
    if (litNow >= Math.min(Math.max(1, stages), satellites)) {
      opportunity += 1;
    }
    if (placement.every((index) => powered[index]?.[at])) {
      placementLit += 1;
    }
  }

  return {
    satellites,
    samples,
    meanSunlitFraction,
    bestSunlitFraction,
    staticPlacementContinuity: placementLit / samples,
    serviceOpportunity: opportunity / samples,
    placement,
  };
}

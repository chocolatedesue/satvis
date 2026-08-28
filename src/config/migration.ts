// The knobs the migration demo is drawn with, kept out of the layer that draws it
// for the same reason the illumination vocabulary is: these are defaults and
// numbers a reader tunes, not rendering logic. Cesium-free so the layer and any
// future panel control read one copy.

/**
 * The KV cache a single decode-pipeline stage carries, in GB.
 *
 * Illustrative, not measured: a real figure is model- and context-dependent
 * (roughly 2·layers·kv_heads·head_dim·seq·batch·dtype bytes). 2 GB is a plausible
 * per-stage working set for a mid-size model at a few thousand tokens of context,
 * and it is what the transfer-time readout is computed from — so the number on
 * screen is honest arithmetic against the link, not a guess.
 */
export const DEFAULT_KV_GIGABYTES = 2;

/**
 * The inter-satellite link bandwidth, in Gbps.
 *
 * The single constraint LAB-47 fixed for the migration problem: one ISL at
 * 100 Gbps. Serialising 2 GB across it is 160 ms — the figure the demo exists to
 * make concrete.
 */
export const ISL_GBPS = 100;

/**
 * How long the packet takes to cross the link on screen, in **simulated** seconds.
 *
 * Two separate decisions live in this one number, and conflating them was the bug
 * LAB-89 fixed.
 *
 * *Simulated* rather than wall-clock, because everything else on screen moves on
 * the simulation clock: at 60× the satellites cross a terminator in a wall second,
 * and a packet pinned to `performance.now()` crawled across the link at the same
 * speed no matter where the multiplier was set. Anchoring the flight to the clock
 * makes the whole scene one timebase — wind the clock up and migrations get quicker,
 * pause it and the packet stops mid-link, exactly as a viewer expects.
 *
 * *30 seconds* rather than the real transfer time, because the real transfer is
 * ~0.17 s (2 GB over 100 Gbps, plus light travel) and nobody can watch that. So the
 * dot is illustrative — ~180× slower than the physics — while the *computed*
 * transfer seconds ride alongside as text, which is where the cost is told honestly.
 * At the demo's 60× that is half a wall second; wound to thousands of × it is under
 * a frame, which is the right answer for a clock running that fast.
 */
export const MIGRATION_ANIMATION_SIM_SECONDS = 30;

/**
 * How often the migration decision is re-evaluated, in **simulated** seconds.
 *
 * A migration is a state change a person reads, not a per-frame animation, so the
 * decision is throttled — but throttled on the simulation clock for the same reason
 * the flight is. On a wall-clock throttle the pipeline's reaction time was a
 * function of the multiplier: a third of a wall second is 0.3 simulated seconds at
 * 1× and 20 simulated *minutes* at 4000×, so winding the clock up left stages
 * sitting dark for a fifth of an orbit before anyone asked them to move — and the
 * served fraction, which is supposed to describe the orbit, moved with the playback
 * rate.
 *
 * Five simulated seconds is far below any illumination change worth reacting to, and
 * above one frame at everyday multipliers; past ~300× it falls under a frame and the
 * decision simply runs every frame, which is as prompt as the clock allows.
 */
export const MIGRATION_EVAL_SIM_SECONDS = 5;

/**
 * The colours the migration overlay draws in, as CSS hex so both the globe
 * (Color.fromCssColorString) and any legend read one table.
 *
 * Chosen to sit apart from the five illumination hues already on the points and
 * arcs: a cyan packet and link read as "the network", not as another power state,
 * against the warm/blue illumination palette. Green marks the satellite currently
 * doing the compute; red marks a workload the naive model has stranded.
 */
export const MIGRATION_COLOR = {
  host: "#009e73",
  link: "#56b4e9",
  packet: "#ffffff",
  stranded: "#d55e00",
} as const;

/**
 * How many stages the demo pipeline is cut into.
 *
 * Four is the smallest number that makes the pipeline's defining property visible:
 * the pipeline serves only while *every* stage has power, so four stages need four
 * coincidences at once. One stage would just restate the fleet's dark fraction;
 * four turns it into the conjunction that actually bounds served time.
 */
export const DEFAULT_PIPELINE_STAGES = 4;

/** The stage counts the panel offers. Bounded by what stays readable on the globe. */
export const PIPELINE_STAGE_CHOICES = [1, 2, 4, 6, 8] as const;

/**
 * Per-stage hues for the host halos and links, so a reader can follow one stage
 * through a migration rather than seeing four interchangeable dots.
 *
 * Deliberately not the illumination palette (that vocabulary means power state) and
 * not the five illumination hues — these are Okabe–Ito entries chosen to stay
 * distinguishable against both the lit globe and space, and to cycle if someone asks
 * for more stages than there are colours.
 */
export const STAGE_COLORS = ["#56b4e9", "#e69f00", "#cc79a7", "#f0e442", "#0072b2", "#d55e00", "#009e73", "#999999"] as const;

/** The hue stage `index` draws in, cycling when the pipeline is longer than the palette. */
export function stageColor(index: number): string {
  return STAGE_COLORS[index % STAGE_COLORS.length] as string;
}

/**
 * The largest jump in simulated time still counted as continuous playback, in
 * seconds.
 *
 * The ledger accrues served and stalled time from the clock, and the clock can be
 * scrubbed, reversed or jumped by the time controls. At 4000× — what the browser
 * check winds to — one 60 fps frame is already ~67 simulated seconds, so the cutoff
 * has to sit well above that while still rejecting a scrub across hours.
 */
export const MAX_SIM_STEP_SECONDS = 3600;

/** How many completed migrations the event log keeps. */
export const MIGRATION_LOG_LENGTH = 6;

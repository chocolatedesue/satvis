// The shape of a satellite's sampled-position window, as arithmetic on plain
// numbers.
//
// It lives here rather than inside SampledTrajectory because two things have to
// agree on it exactly: the trajectory, which fills the window, and the
// propagation prefetch, which computes the same samples ahead of time in a
// worker. A prefetch whose sample times are half a step out of phase with the
// window is not a cache, it is dead weight — so there is one function and both
// callers use it.

/**
 * Samples per revolution. 120 is a compromise between accuracy and both of the
 * costs it drives: propagation time, and the memory the samples occupy (see
 * SampledTrajectory).
 */
export const SAMPLES_PER_ORBIT = 120;

/** Kept behind the satellite, as a fraction of one revolution. */
export const WINDOW_ORBITS_BACK = 0.5;

/** Kept ahead of it. The Orbit component needs a full revolution of it. */
export const WINDOW_ORBITS_FORWARD = 1.5;

export interface TrajectoryWindow {
  /** Seconds from the reference time to the first sample. Negative. */
  offsetSeconds: number;
  stepSeconds: number;
  /** How many samples span the whole window, first and last inclusive. */
  sampleCount: number;
  /** For the caller that wants an interval rather than a count. */
  spanSeconds: number;
}

/**
 * The window for one satellite, from its orbital period in minutes.
 *
 * `sampleCount` is deliberately derived the way the filling loop counts rather
 * than by dividing the span: the loop steps from the start while
 * `stop >= time`, so it lands on the stop boundary and takes it, giving one more
 * sample than the number of steps. At 120 samples an orbit over two orbits that
 * is 241, not 240 — measured against the running app, which reported exactly 241
 * samples per satellite.
 */
export function trajectoryWindow(orbitalPeriodMinutes: number): TrajectoryWindow {
  // A satrec that failed to parse reports no mean motion, and the period derived
  // from it is zero or infinite. Left alone that divides to NaN and reaches the
  // worker as a NaN-sized buffer, so it is answered with an empty window instead:
  // no samples to prefetch, and the caller propagates for itself as it would for
  // any other miss.
  if (!Number.isFinite(orbitalPeriodMinutes) || orbitalPeriodMinutes <= 0) {
    return { offsetSeconds: 0, stepSeconds: 0, sampleCount: 0, spanSeconds: 0 };
  }
  const orbitalPeriodSeconds = orbitalPeriodMinutes * 60;
  const stepSeconds = orbitalPeriodSeconds / SAMPLES_PER_ORBIT;
  const spanSeconds = orbitalPeriodSeconds * (WINDOW_ORBITS_BACK + WINDOW_ORBITS_FORWARD);
  return {
    offsetSeconds: -orbitalPeriodSeconds * WINDOW_ORBITS_BACK,
    stepSeconds,
    sampleCount: Math.floor(spanSeconds / stepSeconds) + 1,
    spanSeconds,
  };
}

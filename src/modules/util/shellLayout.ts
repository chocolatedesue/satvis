// Multi-shell layouts: which pairs of Walker shells hold a fixed relation to
// each other, and which of them quietly shear apart.
//
// `./constellationLinks.ts` wires each shell to itself and stops there, because
// the derivation found nothing stable between two shells picked at random:
// different periods slide the along-track offset forever, and different
// inclinations precess the two planes apart at whole degrees a day. That is a
// finding about the *shells that were tried*, not a law — and this module is the
// law it was missing. A shell pair is described by two secular rates, and both of
// them are closed form:
//
//   - **The node rate** Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i — how fast the J₂ bulge
//     turns the orbit plane. Two shells keep a fixed relative plane arrangement
//     exactly when their node rates agree; otherwise their crossing seam walks
//     round the globe at the difference, and every geometric relation between
//     them is a function of the date.
//   - **The along-track rate** u̇ = ṁ + ω̇ = n[1 + J₂ (Rₑ/a)² (6cos²i − 3/2)] —
//     how fast a satellite runs round its own orbit, argument of latitude being
//     the angle that places a satellite in a circular orbit. Two shells return to
//     the same relative phase exactly when the ratio of their along-track rates
//     is rational, and how long that takes is the ratio's denominator.
//
// Which gives the one theorem this file exists for, and it is a negative one:
//
//   **No two distinct shells are rigid.** Freezing the phases wants equal mean
//   motion, which wants equal altitude; freezing the planes wants equal Ω̇,
//   which at equal altitude wants equal inclination — and that is the same
//   shell. Anything else moves.
//
// So "stable" across shells cannot mean "still", and the useful weakening is
// **periodic**: match the node rates so the planes hold their arrangement, then
// choose the altitudes so the along-track rates are in a small-integer ratio, and
// the entire relative configuration returns — every range, every contact window,
// every hand-off opportunity — on a cycle you can write on a timetable. That is a
// layout a routing table can be computed for once, against a fleet that would
// otherwise need it recomputed forever.
//
// Everything here is a **secular J₂ two-body** result in the WGS-72 system the
// rest of this folder works in, so it agrees with the element sets
// `./walkerDelta.ts` generates. It is a design tool, not a mission analysis: no
// drag, no third body, no J₃, no station-keeping. Against SGP4 the inclination it
// picks lands within about a tenth of a degree and the altitude within a few km —
// `scripts/derive-isl-topology.ts` measures exactly that, and refines both
// against the propagator, which is the honest way round.

// No runtime imports on purpose: scripts/derive-isl-topology.ts runs this file
// through node's own type stripping, which resolves nothing that a bundler would
// have to. The mean motion below is therefore restated rather than imported from
// ./walkerDelta.ts, and the tests assert the two agree to the last bit — a
// duplicated formula that is checked is a seam; one that is not is a bug waiting
// for the day someone changes only one of them.

/** WGS-72, matching walkerDelta and therefore SGP4's own recovered elements. */
const EARTH_RADIUS_KM = 6378.135;
const MU_KM3_S2 = 398600.8;
const SECONDS_PER_DAY = 86400;
const J2 = 0.001082616;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Revolutions a day for a circular orbit at this altitude — `walkerDelta.meanMotionRevPerDay`. */
function keplerianRevPerDay(altitudeKm: number): number {
  const a = EARTH_RADIUS_KM + altitudeKm;
  return (Math.sqrt(MU_KM3_S2 / (a * a * a)) * SECONDS_PER_DAY) / (2 * Math.PI);
}

/** A shell, reduced to the two numbers its rates depend on. */
export interface ShellOrbit {
  altitudeKm: number;
  inclinationDeg: number;
}

/** The secular rates that decide how a shell moves relative to any other. */
export interface ShellRates {
  /** Revolutions a day, the two-body value `walkerDeltaRecords` states. */
  meanMotionRevPerDay: number;
  /** Orbital period in minutes, the Keplerian one. */
  periodMinutes: number;
  /** Ω̇ in degrees a day: negative for a prograde orbit, positive for a retrograde one. */
  nodeRateDegPerDay: number;
  /**
   * u̇ in degrees a day: how fast the satellite runs round its own orbit,
   * measured from the ascending node.
   *
   * Not quite 360°/period: J₂ moves the node the satellite is measured from and
   * the perigee it is measured to, and the along-track rate is what is left when
   * both are folded in — `ṁ + ω̇`, which for a circular orbit is the whole of the
   * motion that matters. The correction is a part in a thousand, which is
   * invisible in one orbit and a degree of phase after a hundred.
   */
  alongTrackRateDegPerDay: number;
}

/** The semi-major axis of a circular orbit at this altitude. */
function semiMajorAxisKm(altitudeKm: number): number {
  return EARTH_RADIUS_KM + altitudeKm;
}

/**
 * The two secular rates of a circular orbit at this altitude and inclination.
 *
 * `Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i` is the same expression `./sunSynchronous.ts`
 * inverts for the sun-synchronous inclination; it is repeated through here rather
 * than imported so a shell's two rates are read off one object, and the two files
 * are checked against each other in the tests.
 */
export function shellRates(orbit: ShellOrbit): ShellRates {
  const { altitudeKm, inclinationDeg } = orbit;
  const revPerDay = keplerianRevPerDay(altitudeKm);
  const axisRatioSquared = (EARTH_RADIUS_KM / semiMajorAxisKm(altitudeKm)) ** 2;
  const cosine = Math.cos(inclinationDeg * DEG_TO_RAD);
  const degPerDay = revPerDay * 360;
  return {
    meanMotionRevPerDay: revPerDay,
    periodMinutes: 1440 / revPerDay,
    nodeRateDegPerDay: -1.5 * J2 * degPerDay * axisRatioSquared * cosine,
    alongTrackRateDegPerDay: degPerDay * (1 + J2 * axisRatioSquared * (6 * cosine * cosine - 1.5)),
  };
}

/**
 * The inclination at `altitudeKm` whose node rate matches the reference shell's,
 * or undefined when no inclination does.
 *
 * Ω̇ scales as `a^(−7/2) cos i`, so the match is one line:
 *
 *   cos i₂ = cos i₁ · (a₂/a₁)^(7/2)
 *
 * A companion **below** the reference always exists — the factor shrinks the
 * cosine and pushes the inclination towards 90°. A companion **above** it runs
 * out: the cosine grows with the 7/2 power of the altitude ratio and passes 1,
 * beyond which no plane precesses slowly enough to keep up. That ceiling is a
 * real design limit rather than a numerical one, and `coPrecessingCeilingKm`
 * reports where it falls.
 */
export function coPrecessingInclinationDeg(reference: ShellOrbit, altitudeKm: number): number | undefined {
  if (!Number.isFinite(altitudeKm) || altitudeKm <= -EARTH_RADIUS_KM) {
    return undefined;
  }
  const ratio = semiMajorAxisKm(altitudeKm) / semiMajorAxisKm(reference.altitudeKm);
  const cosine = Math.cos(reference.inclinationDeg * DEG_TO_RAD) * ratio ** 3.5;
  if (cosine < -1 || cosine > 1) {
    return undefined;
  }
  return Math.acos(cosine) * RAD_TO_DEG;
}

/**
 * The highest altitude that can still be node-locked to this reference shell.
 *
 * Where `cos i₂` reaches ±1, which is `a₁ · |cos i₁|^(−2/7) − Rₑ`. A 53° / 550 km
 * shell tops out near 1630 km: above that its companion would have to precess
 * more slowly than an equatorial orbit at that altitude, and nothing does.
 *
 * The ceiling runs away as the reference approaches polar, which is the same
 * statement read the other way: a node that barely turns is a rate almost any
 * altitude can match, by being nearly polar too. Infinite only for a cosine of
 * exactly zero — 90.000° lands at 6e-17 rather than at 0, so a polar reference
 * reports a number with nine digits in front of the decimal point instead, and
 * that is the honest answer rather than an epsilon's opinion of one.
 */
export function coPrecessingCeilingKm(reference: ShellOrbit): number {
  const cosine = Math.abs(Math.cos(reference.inclinationDeg * DEG_TO_RAD));
  if (cosine <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return semiMajorAxisKm(reference.altitudeKm) * cosine ** (-2 / 7) - EARTH_RADIUS_KM;
}

/**
 * The fewest satellites a plane needs before its ring links clear the Earth:
 * the smallest S with `a·cos(π/S) > Rₑ`.
 *
 * A wiring constraint that is really a fleet-design one, and the reason the
 * stacked-shells demo flies 10 satellites per plane at 550 km — below the
 * threshold every intra-plane link is drawn through the ground. Lives here
 * because a generated companion shell has to satisfy it to be worth generating.
 */
export function minSatellitesPerRing(altitudeKm: number): number {
  return Math.ceil(Math.PI / Math.acos(EARTH_RADIUS_KM / semiMajorAxisKm(altitudeKm)));
}

/** A whole-number resonance between two shells' along-track rates. */
export interface ShellResonance {
  /** Revolutions the reference shell makes in one repeat cycle. */
  referenceRevolutions: number;
  /** Revolutions the companion makes in the same cycle. */
  companionRevolutions: number;
  /** How long the cycle takes, in hours. */
  repeatHours: number;
  /**
   * How far the companion misses its own whole revolution by, in degrees of
   * along-track angle, once per cycle.
   *
   * Zero for a pair designed to the resonance; whatever the best rational
   * approximation leaves for a pair that was not. This is the number that says
   * whether "it repeats" is a claim or a rounding: a slip of a degree per cycle
   * is 130 km of along-track error at LEO, which a contact schedule can absorb;
   * ten degrees a cycle is a schedule that is wrong within a week.
   */
  slipDegPerCycle: number;
}

/**
 * The longest repeat cycle worth calling one.
 *
 * A cycle is a promise that the configuration comes back, and a promise that
 * takes 32 revolutions — about two days at LEO — is still a schedule. Beyond
 * that every ratio is approximable by *something*, and the approximation stops
 * meaning anything: with a large enough denominator "resonant" describes every
 * pair of numbers, which is another way of describing none.
 */
export const MAX_REPEAT_REVOLUTIONS = 32;

/**
 * The best whole-number resonance between two along-track rates, searched over
 * cycles up to `MAX_REPEAT_REVOLUTIONS` revolutions of the reference.
 *
 * Straight enumeration rather than continued fractions: the search space is 32
 * candidates, the winner is the one with the least slip per cycle, and a
 * continued-fraction expansion would have to be re-derived into the same answer
 * anyway. Ties go to the shorter cycle, which is the one a schedule can use.
 */
export function bestResonance(referenceRateDegPerDay: number, companionRateDegPerDay: number, maxRevolutions = MAX_REPEAT_REVOLUTIONS): ShellResonance | undefined {
  if (!(referenceRateDegPerDay > 0) || !(companionRateDegPerDay > 0)) {
    return undefined;
  }
  let best: ShellResonance | undefined;
  for (let revolutions = 1; revolutions <= maxRevolutions; revolutions += 1) {
    const cycleDays = (revolutions * 360) / referenceRateDegPerDay;
    const companionTurns = (companionRateDegPerDay * cycleDays) / 360;
    const whole = Math.round(companionTurns);
    if (whole < 1) {
      continue;
    }
    const slipDegPerCycle = Math.abs(companionTurns - whole) * 360;
    if (!best || slipDegPerCycle < best.slipDegPerCycle - 1e-9) {
      best = { referenceRevolutions: revolutions, companionRevolutions: whole, repeatHours: cycleDays * 24, slipDegPerCycle };
    }
  }
  return best;
}

/**
 * What a pair of shells does to each other, in one word.
 *
 * - `rigid` — the same period *and* the same node rate. Every offset between the
 *   two is frozen: this is one shell flown as two patterns, which is what a
 *   phased sub-constellation or a second RAAN offset at the same altitude and
 *   inclination actually is.
 * - `repeating` — the node rates match and the along-track rates are in a
 *   small-integer ratio, so the whole configuration returns every repeat cycle.
 *   The designed answer, and the only one available between different altitudes.
 * - `phase-locked` — the same period, so the along-track offsets never move, but
 *   different node rates, so the planes shear past each other. Bounded within an
 *   orbit and unbounded across a month: the stacked-shells demo's two 1200 km
 *   shells are this, and their seam walks 2.6° of RAAN a day.
 * - `node-locked` — the planes hold their arrangement, but the along-track rates
 *   are in no useful ratio, so the phases slide through each other forever. Half
 *   a layout: every co-precessing altitude is this until an altitude is chosen
 *   that also closes the cycle, which is the step `resonantCompanion` takes.
 * - `drifting` — neither rate matches. Nothing about the pair's geometry repeats,
 *   and no fixed cross-shell wiring survives.
 *
 * Two questions, two answers each: do the planes hold, and do the phases return.
 * The five names are the four combinations, with the both-hold corner split by
 * whether the phases are frozen (`rigid`) or merely periodic (`repeating`).
 */
export type ShellPairVerdict = "rigid" | "repeating" | "phase-locked" | "node-locked" | "drifting";

/**
 * How closely two node rates must agree to count as locked: 0.01°/day, which is
 * a degree of seam movement in a hundred days.
 *
 * Loose enough that the secular model's own error against SGP4 (a few
 * thousandths of a degree a day, measured in the derivation script) does not
 * disqualify a pair it designed, and tight enough that a pair which merely looks
 * close — the stacked-shells demo's 2.58°/day, say — never passes.
 */
export const NODE_LOCK_TOLERANCE_DEG_PER_DAY = 0.01;

/** How closely two periods must agree to count as equal: a part in a hundred thousand. */
export const PERIOD_LOCK_TOLERANCE = 1e-5;

/**
 * How much along-track slip a repeat cycle may carry and still be a repeat:
 * one degree, which is about 130 km at LEO.
 */
export const REPEAT_SLIP_TOLERANCE_DEG = 1;

export interface ShellPairLayout {
  verdict: ShellPairVerdict;
  /** Ω̇₁ − Ω̇₂: how fast the two shells' planes shear past each other. */
  nodeShearDegPerDay: number;
  /**
   * Days before the shear moves the shells' relative node by one degree.
   * Infinite for a locked pair; a couple of hours for a badly matched one.
   */
  seamHoldDays: number;
  /** The companion's period divided by the reference's. */
  periodRatio: number;
  /** The best whole-number return the along-track rates admit, if any. */
  resonance: ShellResonance | undefined;
}

/**
 * Analyse one ordered pair of shells: what holds between them, and what does not.
 *
 * Ordered because the resonance is quoted in the reference's revolutions, not
 * because the physics has a preferred direction — reverse the arguments and the
 * verdict is the same with the cycle counted the other way.
 */
export function shellPairLayout(reference: ShellOrbit, companion: ShellOrbit): ShellPairLayout {
  const a = shellRates(reference);
  const b = shellRates(companion);
  const nodeShearDegPerDay = a.nodeRateDegPerDay - b.nodeRateDegPerDay;
  const nodeLocked = Math.abs(nodeShearDegPerDay) <= NODE_LOCK_TOLERANCE_DEG_PER_DAY;
  const periodRatio = b.periodMinutes / a.periodMinutes;
  const samePeriod = Math.abs(periodRatio - 1) <= PERIOD_LOCK_TOLERANCE;
  const resonance = bestResonance(a.alongTrackRateDegPerDay, b.alongTrackRateDegPerDay);
  const returns = resonance !== undefined && resonance.slipDegPerCycle <= REPEAT_SLIP_TOLERANCE_DEG;
  const verdict: ShellPairVerdict = samePeriod ? (nodeLocked ? "rigid" : "phase-locked") : nodeLocked ? (returns ? "repeating" : "node-locked") : "drifting";
  return {
    verdict,
    nodeShearDegPerDay,
    seamHoldDays: nodeShearDegPerDay === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / nodeShearDegPerDay),
    periodRatio,
    resonance,
  };
}

/**
 * Whether the pair's geometry comes back — the question a drawn bond answers,
 * collapsed from the five verdicts to the one bit a line style can carry.
 *
 * `phase-locked` counts: its along-track offsets never move, so the pair holds
 * its distance envelope orbit after orbit even while the planes shear underneath
 * it. `node-locked` does not: the planes hold, but the two satellites slide
 * through each other's phase forever, which is what the bond is drawn to show.
 */
export function configurationReturns(verdict: ShellPairVerdict): boolean {
  return verdict === "rigid" || verdict === "repeating" || verdict === "phase-locked";
}

/** A companion shell the search found, and why it is worth flying. */
export interface StableShellLayout {
  altitudeKm: number;
  inclinationDeg: number;
  /** Reference revolutions per repeat cycle, and the companion's. */
  resonance: ShellResonance;
  /** What is left of the node shear after the match — designed to be zero. */
  nodeShearDegPerDay: number;
  /** The fewest satellites per plane whose ring links clear the Earth at this altitude. */
  minPerPlane: number;
}

/**
 * The companion shell that is node-locked to the reference and returns to the
 * same relative configuration every `referenceRevolutions` orbits.
 *
 * Two conditions on two unknowns. The inclination follows from the altitude in
 * closed form (`coPrecessingInclinationDeg`), so only the altitude is searched —
 * and along-track rate falls monotonically with it, which makes the search a
 * bisection rather than a hunt. The two-body starting guess `a₁ · (p/q)^(2/3)` is
 * already within a kilometre or two; the bisection is what carries the J₂ terms,
 * which depend on the inclination the altitude is still choosing.
 *
 * Undefined when the resonance is out of reach — above the co-precession ceiling,
 * or below where an orbit is an orbit.
 */
export function resonantCompanion(reference: ShellOrbit, referenceRevolutions: number, companionRevolutions: number): StableShellLayout | undefined {
  if (!Number.isInteger(referenceRevolutions) || !Number.isInteger(companionRevolutions) || referenceRevolutions < 1 || companionRevolutions < 1) {
    return undefined;
  }
  const referenceRate = shellRates(reference).alongTrackRateDegPerDay;
  // The companion must turn `companionRevolutions` times while the reference
  // turns `referenceRevolutions`, so its along-track rate is fixed before its
  // altitude is.
  const wantedRate = (referenceRate * companionRevolutions) / referenceRevolutions;
  const rateAt = (altitudeKm: number): number | undefined => {
    const inclinationDeg = coPrecessingInclinationDeg(reference, altitudeKm);
    return inclinationDeg === undefined ? undefined : shellRates({ altitudeKm, inclinationDeg }).alongTrackRateDegPerDay;
  };
  const ceilingKm = Math.min(coPrecessingCeilingKm(reference), 100000);
  let low = 150;
  let high = ceilingKm;
  if (rateAt(low) === undefined || rateAt(high) === undefined || (rateAt(low) as number) < wantedRate || (rateAt(high) as number) > wantedRate) {
    return undefined;
  }
  // Along-track rate is strictly decreasing in altitude, so 40 halvings settle
  // an altitude to well under a metre.
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    const rate = rateAt(middle);
    if (rate === undefined) {
      high = middle;
    } else if (rate > wantedRate) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const altitudeKm = (low + high) / 2;
  const inclinationDeg = coPrecessingInclinationDeg(reference, altitudeKm);
  if (inclinationDeg === undefined) {
    return undefined;
  }
  const companion = { altitudeKm, inclinationDeg };
  const rates = shellRates(companion);
  const cycleDays = (referenceRevolutions * 360) / referenceRate;
  return {
    altitudeKm,
    inclinationDeg,
    resonance: {
      referenceRevolutions,
      companionRevolutions,
      repeatHours: cycleDays * 24,
      slipDegPerCycle: Math.abs(rates.alongTrackRateDegPerDay * cycleDays - companionRevolutions * 360),
    },
    nodeShearDegPerDay: shellRates(reference).nodeRateDegPerDay - rates.nodeRateDegPerDay,
    minPerPlane: minSatellitesPerRing(altitudeKm),
  };
}

export interface ShellSearchOptions {
  /** The lowest altitude a companion may fly at. Default 300 km. */
  minAltitudeKm?: number;
  /** The highest. Default 2000 km — above that is the inner Van Allen belt. */
  maxAltitudeKm?: number;
  /** The longest repeat cycle to accept, in reference revolutions. */
  maxRevolutions?: number;
  /** How many layouts to return. Default 6. */
  limit?: number;
}

/**
 * Every stable companion shell for this reference, best first.
 *
 * The search is over resonances rather than over altitudes, which is what makes
 * it exhaustive rather than a sample: each coprime pair `p/q` names exactly one
 * companion altitude, `resonantCompanion` finds it, and the altitude band throws
 * out the ones that fall into the atmosphere or above the belt. What comes back
 * is every layout that exists in the band, not the best few of a grid.
 *
 * Ordered by repeat cycle, shortest first — a configuration that comes back
 * every ten hours is a timetable, one that comes back every two days is a
 * calendar — and ties by the smaller altitude step, since a companion closer to
 * the reference is one its links can actually reach.
 */
export function searchStableShellLayouts(reference: ShellOrbit, options: ShellSearchOptions = {}): StableShellLayout[] {
  const minAltitudeKm = options.minAltitudeKm ?? 300;
  const maxAltitudeKm = options.maxAltitudeKm ?? 2000;
  const maxRevolutions = options.maxRevolutions ?? MAX_REPEAT_REVOLUTIONS;
  const found: StableShellLayout[] = [];
  const seen = new Set<string>();
  for (let referenceRevolutions = 1; referenceRevolutions <= maxRevolutions; referenceRevolutions += 1) {
    for (let companionRevolutions = 1; companionRevolutions <= maxRevolutions; companionRevolutions += 1) {
      if (companionRevolutions === referenceRevolutions || greatestCommonDivisor(referenceRevolutions, companionRevolutions) !== 1) {
        continue;
      }
      const layout = resonantCompanion(reference, referenceRevolutions, companionRevolutions);
      if (!layout || layout.altitudeKm < minAltitudeKm || layout.altitudeKm > maxAltitudeKm) {
        continue;
      }
      const key = `${referenceRevolutions}:${companionRevolutions}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      found.push(layout);
    }
  }
  found.sort((a, b) => a.resonance.repeatHours - b.resonance.repeatHours || Math.abs(a.altitudeKm - reference.altitudeKm) - Math.abs(b.altitudeKm - reference.altitudeKm));
  return found.slice(0, options.limit ?? 6);
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

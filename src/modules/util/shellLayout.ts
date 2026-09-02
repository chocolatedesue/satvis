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
 *
 * `marginKm` defaults to 0, which is the bar the derivation and the ADRs quote:
 * clearing the solid Earth. It is the loose bar — a ring at exactly S = 8 and
 * 550 km clears the ground and grazes the atmosphere, and asking for
 * `LINK_MARGIN_KM` there wants S ≥ 9. Kept as the default so the published
 * numbers mean what they say, and exposed so a design that cares can pay for the
 * extra satellite.
 */
export function minSatellitesPerRing(altitudeKm: number, marginKm = 0): number {
  return Math.ceil(Math.PI / Math.acos((EARTH_RADIUS_KM + marginKm) / semiMajorAxisKm(altitudeKm)));
}

/**
 * How far above the surface a link has to clear to be a link: 80 km, the top of
 * the mesosphere, matching `migration.ts`'s own line-of-sight margin.
 *
 * A chord that grazes the limb passes through atmosphere no optical ISL survives,
 * so "clears the Earth" is the wrong bar by exactly this much.
 */
export const LINK_MARGIN_KM = 80;

/**
 * The longest chord between two circular shells that still clears the Earth:
 * `√(r₁² − R_b²) + √(r₂² − R_b²)`, each term being one satellite's distance to
 * its own horizon.
 *
 * The Earth's constraint on a layout, in one number. Two shells can hold a
 * schedule forever and still never exchange a packet: `shellPairLayout` says
 * whether their geometry *returns*, and this says how much of that geometry is
 * near enough to be a link at all. A stable layout whose members only ever meet
 * across the planet is a stable layout with no fabric on it.
 *
 * Uses this module's WGS-72 equatorial radius, where `migration.ts`'s segment test
 * uses the mean radius — 7 km apart, well inside the 80 km margin, and the
 * conservative way round here.
 */
export function maxLinkRangeKm(altitudeAKm: number, altitudeBKm: number, marginKm = LINK_MARGIN_KM): number {
  const blocking = EARTH_RADIUS_KM + marginKm;
  const reach = (altitudeKm: number) => {
    const radius = semiMajorAxisKm(altitudeKm);
    return radius <= blocking ? 0 : Math.sqrt(radius * radius - blocking * blocking);
  };
  return reach(altitudeAKm) + reach(altitudeBKm);
}

/**
 * The widest Earth-central angle two shells can span and still see each other:
 * `arccos(R_b/r₁) + arccos(R_b/r₂)`.
 *
 * The same statement as `maxLinkRangeKm`, in the units a constellation is designed
 * in — each term is how far round the planet one satellite can see, so the sum is
 * how far apart the pair may be before the limb comes between them.
 */
export function linkHorizonAngleDeg(altitudeAKm: number, altitudeBKm: number, marginKm = LINK_MARGIN_KM): number {
  const blocking = EARTH_RADIUS_KM + marginKm;
  const horizon = (altitudeKm: number) => {
    const radius = semiMajorAxisKm(altitudeKm);
    return radius <= blocking ? 0 : Math.acos(blocking / radius) * RAD_TO_DEG;
  };
  return horizon(altitudeAKm) + horizon(altitudeBKm);
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
 *
 * `maxRevolutions` is the cycle budget, and it is a real parameter rather than a
 * knob: two members of a wide family can be 37 and 47 revolutions apart, and
 * under the default 32 this function reports them `node-locked` — correctly, by
 * its own definition, and misleadingly, because the family they belong to closes
 * both in one cycle. A caller that already knows the cycle should say so.
 */
export function shellPairLayout(reference: ShellOrbit, companion: ShellOrbit, maxRevolutions = MAX_REPEAT_REVOLUTIONS): ShellPairLayout {
  const a = shellRates(reference);
  const b = shellRates(companion);
  const nodeShearDegPerDay = a.nodeRateDegPerDay - b.nodeRateDegPerDay;
  const nodeLocked = Math.abs(nodeShearDegPerDay) <= NODE_LOCK_TOLERANCE_DEG_PER_DAY;
  const periodRatio = b.periodMinutes / a.periodMinutes;
  const samePeriod = Math.abs(periodRatio - 1) <= PERIOD_LOCK_TOLERANCE;
  const resonance = bestResonance(a.alongTrackRateDegPerDay, b.alongTrackRateDegPerDay, maxRevolutions);
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
  /**
   * The longest link this shell and its reference could ever close, from
   * `maxLinkRangeKm`. A layout that returns is not yet a layout that can talk:
   * the pair has to come inside this to exchange anything.
   */
  maxLinkRangeKm: number;
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
    maxLinkRangeKm: maxLinkRangeKm(reference.altitudeKm, altitudeKm),
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

// ---------------------------------------------------------------------------
// Clusters: the partition the two invariants already impose, and how to find it
// ---------------------------------------------------------------------------
//
// Everything above answers "given this shell, where does a second one go". The
// question underneath it is structural, and it has a cleaner answer than the
// construction does:
//
//   **Both conditions are equivalence relations, so the space of circular orbits
//   is already partitioned into stable clusters. Finding them is a quotient, not
//   a search.**
//
// - `Ω̇(a, i) = Ω̇(a', i')` is equality of a real number, so node lock is
//   reflexive, symmetric and transitive by inspection. A cluster does not need
//   its members checked pairwise: they need only sit on one level set of Ω̇,
//   which is one curve in the (altitude, inclination) plane. N constraints, not
//   N².
// - `u̇/u̇' ∈ ℚ` — commensurability — is an equivalence relation for the same
//   reason multiplication by a rational is invertible. So "every pair returns"
//   follows from "every member closes one shared cycle", and the shared cycle is
//   the thing worth choosing.
//
// The intersection of two equivalence relations is an equivalence relation, so
// the classes are exactly the maximal stable clusters, and a satellite belongs
// to precisely one. That is the whole theory, and it is why nothing here is a
// clustering *heuristic*: there is no distance to minimise, no k to choose and
// no centroid to iterate. What a k-means over orbital elements would produce is
// a partition of a space whose real partition is already known in closed form.
//
// What is left for an algorithm is the part the theory does not survive:
// **tolerance**. No two flown orbits have exactly equal Ω̇, and every real ratio
// is rational to within any ε, so both relations have to be relaxed before they
// describe anything real — and a relaxed equivalence relation is not transitive.
// A within ε of B and B within ε of C leaves A and C 2ε apart. Clusters under
// tolerance therefore overlap rather than partition, and the honest output is
// the set of **maximal** clusters rather than an assignment of each satellite to
// one of them.
//
// That makes both stages exact rather than approximate:
//
// 1. **Node lock** reduces to intervals on a line. Sort by Ω̇; a cluster is a
//    window whose spread is within the tolerance; the maximal ones are the
//    maximal cliques of an interval graph, which a single pass over the sorted
//    values enumerates. O(N log N).
// 2. **Common cycle** reduces to simultaneous rational approximation with a
//    budget. Any cycle T is, to within the slip tolerance, a whole multiple of
//    every member's period — so enumerating the multiples of one member's period
//    up to the budget enumerates every candidate, and each candidate names the
//    subset that closes it. O(N²·K) for N members and K candidate multiples, and
//    N here is the number of distinct *orbits*, not satellites.
//
// The optimisation that is left is not the clustering. It is the trade the
// search exposes — members against cycle length against inclination spread —
// and it is a scan over a handful of integers rather than a descent.

/** One orbit offered to the cluster finder, under a name the caller can read back. */
export interface ClusterMember {
  id: string;
  orbit: ShellOrbit;
}

/** A set of orbits whose relative configuration returns, and the cycle it returns on. */
export interface StableCluster {
  /** Member ids, in the order they were given. */
  members: string[];
  /** The node rate the cluster shares. */
  nodeRateDegPerDay: number;
  /** How far its members spread around that rate — the seam drift the cluster carries. */
  nodeSpreadDegPerDay: number;
  /** How long the whole configuration takes to return. */
  cycleHours: number;
  /** Whole revolutions each member makes in one cycle, aligned with `members`. */
  revolutions: number[];
  /** The worst along-track error any member carries into the next cycle. */
  slipDegPerCycle: number;
  /**
   * The tightest link budget in the cluster: the shortest `maxLinkRangeKm` over
   * its member pairs. Whether the cluster's geometry ever brings a pair inside it
   * is a question for the propagator, but a cluster whose members are far apart
   * even at their closest is one no fabric can be built on however well it
   * repeats.
   */
  maxLinkRangeKm: number;
  /**
   * `rigid` when every member shares a period as well as a node rate — one shell
   * flown as several patterns, whose offsets are frozen rather than periodic.
   * `repeating` otherwise.
   */
  verdict: Extract<ShellPairVerdict, "rigid" | "repeating">;
}

export interface ClusterOptions {
  /** How far apart two node rates may be and still count as locked. */
  nodeToleranceDegPerDay?: number;
  /** The longest cycle worth calling a return. Default 48 hours. */
  maxCycleHours?: number;
  /** How much along-track slip a member may carry per cycle. */
  slipToleranceDeg?: number;
  /** The smallest cluster worth reporting. Default 2. */
  minMembers?: number;
}

/** The default ceiling on a cluster's cycle: two days, at which point a schedule is a calendar. */
export const MAX_CLUSTER_CYCLE_HOURS = 48;

/**
 * The maximal sets of members whose node rates all agree to within the
 * tolerance — the coarse half of the partition, on its own.
 *
 * Reported separately from `findStableClusters` because it answers a different
 * question, and one worth asking first: a node-locked group holds its *planes*
 * in a fixed arrangement whether or not its phases ever return, which is what
 * decides whether the fleet's crossing seams stay put. A group that appears here
 * and not below is one whose geometry is half stable — every co-precessing
 * altitude that is not also resonant.
 *
 * Maximal rather than partitioned, because tolerance is not transitive: with a
 * tolerance of 0.01°/day, three shells at 0, 0.008 and 0.016 give two maximal
 * groups that share their middle member, and calling either one *the* cluster
 * would be a choice this function has no grounds to make.
 */
export function nodeLockedGroups(members: readonly ClusterMember[], toleranceDegPerDay = NODE_LOCK_TOLERANCE_DEG_PER_DAY): ClusterMember[][] {
  const rated = members.map((member) => ({ member, rate: shellRates(member.orbit).nodeRateDegPerDay })).toSorted((a, b) => a.rate - b.rate);
  const groups: ClusterMember[][] = [];
  let previousEnd = -1;
  for (let start = 0; start < rated.length; start += 1) {
    let end = start;
    while (end + 1 < rated.length && (rated[end + 1] as (typeof rated)[number]).rate - (rated[start] as (typeof rated)[number]).rate <= toleranceDegPerDay) {
      end += 1;
    }
    // A window contained in the previous one is not maximal, and the windows are
    // produced in order, so the previous one is the only one it could sit inside.
    if (end > previousEnd) {
      groups.push(rated.slice(start, end + 1).map((entry) => entry.member));
      previousEnd = end;
    }
  }
  return groups;
}

/**
 * The shortest cycle within the budget on which every one of these orbits closes
 * a whole number of revolutions, or undefined when none does.
 *
 * Any such cycle is a whole multiple of every member's period, so the multiples
 * of the first member's period are a complete candidate list — enumerate them,
 * and the first that every member closes is the shortest. Anchoring on the
 * longest period keeps the list short without missing anything, since a longer
 * period admits fewer multiples inside the same budget.
 */
export function commonRepeatCycle(
  orbits: readonly ShellOrbit[],
  maxCycleHours = MAX_CLUSTER_CYCLE_HOURS,
  slipToleranceDeg = REPEAT_SLIP_TOLERANCE_DEG,
): { cycleHours: number; revolutions: number[]; slipDegPerCycle: number } | undefined {
  if (orbits.length === 0) {
    return undefined;
  }
  const rates = orbits.map((orbit) => shellRates(orbit).alongTrackRateDegPerDay);
  const anchorRate = Math.min(...rates);
  if (!(anchorRate > 0)) {
    return undefined;
  }
  const anchorPeriodHours = (360 / anchorRate) * 24;
  const candidates = Math.floor(maxCycleHours / anchorPeriodHours);
  for (let multiple = 1; multiple <= candidates; multiple += 1) {
    const cycleHours = multiple * anchorPeriodHours;
    const cycleDays = cycleHours / 24;
    const revolutions: number[] = [];
    let worstSlip = 0;
    for (const rate of rates) {
      const turns = (rate * cycleDays) / 360;
      const whole = Math.round(turns);
      worstSlip = Math.max(worstSlip, Math.abs(turns - whole) * 360);
      revolutions.push(whole);
    }
    if (worstSlip <= slipToleranceDeg) {
      return { cycleHours, revolutions, slipDegPerCycle: worstSlip };
    }
  }
  return undefined;
}

/**
 * Every maximal stable cluster among these orbits, best first.
 *
 * Two stages, in the order the two conditions bite: node-locked groups first,
 * because that is the cheap half and the half that cannot be recovered by
 * waiting longer, then the largest subset of each group that closes one cycle.
 *
 * The subset search is a sweep rather than an enumeration of subsets: each
 * candidate cycle *names* the members that close it, so sweeping the candidate
 * cycles produces every maximal commensurate subset without ever considering a
 * set that no cycle supports. Every member is tried as the anchor, since a
 * cluster that excludes the longest-period member is one its multiples would
 * never propose.
 *
 * Ordered by size, then by the shorter cycle, then by the tighter node spread:
 * a cluster that holds more satellites is a bigger claim, and between two of the
 * same size the one that comes back sooner is the one a schedule can use.
 */
export function findStableClusters(members: readonly ClusterMember[], options: ClusterOptions = {}): StableCluster[] {
  const maxCycleHours = options.maxCycleHours ?? MAX_CLUSTER_CYCLE_HOURS;
  const slipToleranceDeg = options.slipToleranceDeg ?? REPEAT_SLIP_TOLERANCE_DEG;
  const minMembers = options.minMembers ?? 2;
  const found = new Map<string, StableCluster>();

  for (const group of nodeLockedGroups(members, options.nodeToleranceDegPerDay)) {
    const rates = group.map((member) => shellRates(member.orbit));
    for (const anchor of rates) {
      // The *along-track* period, not the Keplerian one: J2 moves the node the
      // angle is measured from, and the part-in-a-thousand between them is 3° of
      // phase after fifteen revolutions — which is the whole error budget a cycle
      // has. Anchoring on `periodMinutes` finds no cluster at all, including the
      // one it was handed.
      const anchorPeriodHours = (360 / anchor.alongTrackRateDegPerDay) * 24;
      const candidates = Math.floor(maxCycleHours / anchorPeriodHours);
      for (let multiple = 1; multiple <= candidates; multiple += 1) {
        const cycleHours = multiple * anchorPeriodHours;
        const cycleDays = cycleHours / 24;
        const subset: number[] = [];
        const revolutions: number[] = [];
        let worstSlip = 0;
        for (let at = 0; at < group.length; at += 1) {
          const turns = ((rates[at] as ShellRates).alongTrackRateDegPerDay * cycleDays) / 360;
          const whole = Math.round(turns);
          const slip = Math.abs(turns - whole) * 360;
          if (whole >= 1 && slip <= slipToleranceDeg) {
            subset.push(at);
            revolutions.push(whole);
            worstSlip = Math.max(worstSlip, slip);
          }
        }
        if (subset.length < minMembers) {
          continue;
        }
        const ids = subset.map((at) => (group[at] as ClusterMember).id);
        const key = ids.toSorted().join("|");
        const existing = found.get(key);
        if (existing && existing.cycleHours <= cycleHours) {
          continue;
        }
        const nodeRates = subset.map((at) => (rates[at] as ShellRates).nodeRateDegPerDay);
        const periods = subset.map((at) => (rates[at] as ShellRates).periodMinutes);
        const altitudes = subset.map((at) => (group[at] as ClusterMember).orbit.altitudeKm);
        let tightestLinkKm = Infinity;
        for (let a = 0; a < altitudes.length; a += 1) {
          for (let b = a + 1; b < altitudes.length; b += 1) {
            tightestLinkKm = Math.min(tightestLinkKm, maxLinkRangeKm(altitudes[a] as number, altitudes[b] as number));
          }
        }
        found.set(key, {
          members: ids,
          nodeRateDegPerDay: nodeRates.reduce((a, b) => a + b, 0) / nodeRates.length,
          nodeSpreadDegPerDay: Math.max(...nodeRates) - Math.min(...nodeRates),
          cycleHours,
          revolutions,
          slipDegPerCycle: worstSlip,
          maxLinkRangeKm: Number.isFinite(tightestLinkKm) ? tightestLinkKm : maxLinkRangeKm(altitudes[0] as number, altitudes[0] as number),
          // Every member on one period as well as one node rate is not a family
          // that returns — it is one shell, and its offsets never moved at all.
          verdict: Math.max(...periods) - Math.min(...periods) <= (Math.max(...periods) as number) * PERIOD_LOCK_TOLERANCE ? "rigid" : "repeating",
        });
      }
    }
  }

  // What survives is the Pareto front of size against cycle, not a partition and
  // not a single answer: a subset of a bigger cluster is kept when it comes back
  // *sooner*, because that is a different offer rather than a worse one. Three
  // shells at 25, 30 and 35 turns return every fifth of the cycle their eight-shell
  // family needs, and a scheduler that only wants three should be told so. Only a
  // subset that is no faster than the cluster containing it is dropped.
  const clusters = [...found.values()];
  const maximal = clusters.filter(
    (cluster) =>
      !clusters.some(
        (other) =>
          other !== cluster &&
          other.members.length > cluster.members.length &&
          other.cycleHours <= cluster.cycleHours &&
          cluster.members.every((member) => other.members.includes(member)),
      ),
  );
  return maximal.toSorted((a, b) => b.members.length - a.members.length || a.cycleHours - b.cycleHours || a.nodeSpreadDegPerDay - b.nodeSpreadDegPerDay);
}

/** One shell of a constructed family: where it flies, and how many turns it takes per cycle. */
export interface FamilyShell extends StableShellLayout {
  /** Whole revolutions this shell makes in the family's shared cycle. */
  revolutions: number;
}

export interface FamilyOptions extends ShellSearchOptions {
  /** How many revolutions the reference itself makes per cycle. */
  cycleRevolutions: number;
}

/**
 * The whole family a reference shell can hold at once, rather than one companion
 * at a time.
 *
 * `findStableClusters` reads a partition off orbits that already exist; this
 * writes one. Fix the reference's own revolutions per cycle and the cycle length
 * follows; every other whole number of revolutions inside the altitude band then
 * names one more shell, node-locked to the same curve and closing the same
 * cycle. Every pair among them repeats by construction — which is the point of
 * choosing a shared cycle rather than pairwise ratios, whose least common
 * multiple would grow with every shell added.
 *
 * The count is bounded by the band rather than by the arithmetic: the altitude
 * floor and the co-precession ceiling fix a ratio of periods, and the shells are
 * the integers that fit inside it. Roughly one more shell per six hours of
 * cycle at 550 km — and far more than that from a near-polar reference, whose
 * ceiling is thousands of kilometres higher because matching a node rate near
 * zero costs almost no inclination.
 *
 * The reference is included, at `revolutions = cycleRevolutions`. A family whose
 * revolution counts share a factor returns sooner than its stated cycle, so the
 * caller that wants the true cycle should divide by their greatest common
 * divisor — `familyCycleHours` does.
 */
export function shellFamily(reference: ShellOrbit, options: FamilyOptions): FamilyShell[] {
  const { cycleRevolutions } = options;
  if (!Number.isInteger(cycleRevolutions) || cycleRevolutions < 1) {
    return [];
  }
  const minAltitudeKm = options.minAltitudeKm ?? 300;
  const maxAltitudeKm = options.maxAltitudeKm ?? 2000;
  const rates = shellRates(reference);
  const cycleHours = ((cycleRevolutions * 360) / rates.alongTrackRateDegPerDay) * 24;
  const shells: FamilyShell[] = [];
  // A shell can turn no more than the band's fastest orbit allows, so the search
  // stops well before the loop's own ceiling; four times the reference's count
  // clears the whole band at any altitude worth flying.
  for (let revolutions = 1; revolutions <= cycleRevolutions * 4; revolutions += 1) {
    if (revolutions === cycleRevolutions) {
      shells.push({
        altitudeKm: reference.altitudeKm,
        inclinationDeg: reference.inclinationDeg,
        resonance: { referenceRevolutions: cycleRevolutions, companionRevolutions: revolutions, repeatHours: cycleHours, slipDegPerCycle: 0 },
        nodeShearDegPerDay: 0,
        minPerPlane: minSatellitesPerRing(reference.altitudeKm),
        maxLinkRangeKm: maxLinkRangeKm(reference.altitudeKm, reference.altitudeKm),
        revolutions,
      });
      continue;
    }
    const layout = resonantCompanion(reference, cycleRevolutions, revolutions);
    if (!layout || layout.altitudeKm < minAltitudeKm || layout.altitudeKm > maxAltitudeKm) {
      continue;
    }
    shells.push({ ...layout, revolutions });
  }
  return shells.toSorted((a, b) => a.altitudeKm - b.altitudeKm);
}

/**
 * How long a family really takes to come back.
 *
 * The stated cycle divided by the greatest common divisor of its members'
 * revolution counts: shells at 14 and 16 turns close together twice per stated
 * cycle, and quoting the longer number would be quoting a cycle nobody waits.
 */
export function familyCycleHours(shells: readonly FamilyShell[]): number {
  if (shells.length === 0) {
    return 0;
  }
  const divisor = shells.map((shell) => shell.revolutions).reduce((a, b) => greatestCommonDivisor(a, b));
  return (shells[0] as FamilyShell).resonance.repeatHours / divisor;
}

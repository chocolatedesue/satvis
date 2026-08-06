// The TEME to pseudo-fixed rotation, as arithmetic on epoch milliseconds.
//
// Cesium's `Transforms.computeTemeToPseudoFixedMatrix` is a rotation about Z by a
// single angle, and everything around it is overhead on six useful flops: a
// `JulianDate` per sample, a leap-second lookup, a `Matrix3` allocated because the
// call site passes no result, and a full 3x3 multiply. Measured over 5,000
// satellites of 241 samples, the transform half of a window fill:
//
//     Cesium, as #applyChunk called it   220 ms
//     Cesium, with scratch objects       105 ms
//     this, rotation written inline       31 ms
//
// It is the same formula rather than an approximation of it — the constants below
// are Cesium's — so the two agree to 0.001 mm over 42 anchors spanning three years,
// including the midnight and noon crossings where the parameterisation changes
// branch. The point is not a cheaper transform but a Cesium-free one: it can move
// into the propagation worker, where the main thread stops paying for it at all.
//
// Deliberately *not* the GMST that satellite.js's `gstime` computes. That evaluates
// the polynomial at the instant where this evaluates it at 0h and adds Earth's
// rotation rate since; they differ by 1.5e-9 rad, which is 1 cm at LEO and 6 cm at
// GEO. Immaterial on its own — the interpolation error in GridPositionProperty is
// metres — but this way the stored positions stay bit-identical to what Cesium's own
// transform produced, so the change is invisible to everything downstream.

/** Cesium's GMST polynomial, in seconds, evaluated in Julian centuries from J2000. */
const GMST_C0 = 6 * 3600 + 41 * 60 + 50.54841;
const GMST_C1 = 8640184.812866;
const GMST_C2 = 0.093104;
const GMST_C3 = -6.2e-6;

/** Precession of the rotation rate, per day from J2000. */
const RATE_COEF = 1.1772758384668e-19;

const WGS84_WR_PRECESSING = 7.2921158553e-5;

const TWO_PI = Math.PI * 2;
const TWO_PI_OVER_SECONDS_IN_DAY = TWO_PI / 86400;
const SECONDS_PER_DAY = 86400;
const MS_PER_DAY = 86_400_000;
const J2000_DAY_NUMBER = 2451545;

/** Cesium splits a Julian date this way, and the Unix epoch lands mid-day in it. */
const UNIX_EPOCH_DAY_NUMBER = 2440587;
const UNIX_EPOCH_SECONDS_OF_DAY = 43200;

/**
 * Greenwich hour angle for a UTC instant, in radians.
 *
 * Unix time is already UTC, which is the frame Cesium reduces to before doing this
 * arithmetic — it converts UTC to TAI on the way in and subtracts `taiMinusUtc` back
 * off here — so taking epoch milliseconds skips a round trip rather than skipping a
 * correction. The one case where that is not merely equivalent is an interval
 * spanning a leap second, where TAI and Unix time disagree about how many seconds
 * elapsed; see the test, which pins the bound rather than assuming it away.
 */
export function greenwichHourAngle(epochMs: number): number {
  // The day is split off as an integer first. Carrying the whole Julian date in one
  // double puts the value near 2.44e6, whose ulp is about 47 us of Earth rotation —
  // measured as a 9.5 mm error before this was split. Keeping `secondsOfDay` small
  // keeps its resolution.
  const days = Math.floor(epochMs / MS_PER_DAY);
  const msIntoDay = epochMs - days * MS_PER_DAY;
  let dayNumber = UNIX_EPOCH_DAY_NUMBER + days;
  let secondsOfDay = UNIX_EPOCH_SECONDS_OF_DAY + msIntoDay / 1000;
  if (secondsOfDay >= SECONDS_PER_DAY) {
    secondsOfDay -= SECONDS_PER_DAY;
    dayNumber += 1;
  }

  // GMST is tabulated at 0h, so the half-day offset picks the tabulation this
  // instant belongs to.
  const centuries = (dayNumber - J2000_DAY_NUMBER + (secondsOfDay >= 43200 ? 0.5 : -0.5)) / 36525;
  const gmstSeconds = GMST_C0 + centuries * (GMST_C1 + centuries * (GMST_C2 + centuries * GMST_C3));
  const angleAt0h = (gmstSeconds * TWO_PI_OVER_SECONDS_IN_DAY) % TWO_PI;
  const rotationRate = WGS84_WR_PRECESSING + RATE_COEF * (dayNumber - 2451545.5);
  const secondsSinceMidnight = (secondsOfDay + 43200) % SECONDS_PER_DAY;
  return angleAt0h + rotationRate * secondsSinceMidnight;
}

/**
 * The rotation for one instant, as the cosine and sine of the hour angle.
 *
 * Handed back as a pair rather than a matrix because seven of the nine entries are
 * constant: the fixed-frame position is
 * `(c*x + s*y, -s*x + c*y, z)`.
 */
export interface FixedRotation {
  cos: number;
  sin: number;
}

export function fixedRotationAt(epochMs: number, result: FixedRotation): FixedRotation {
  const gha = greenwichHourAngle(epochMs);
  result.cos = Math.cos(gha);
  result.sin = Math.sin(gha);
  return result;
}

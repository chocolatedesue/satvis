// Turning a phone's orientation into an aim for the sky view.
//
// VERIFIED ON iOS: the sign of the screen-orientation correction and the
// `360 - webkitCompassHeading` substitution are both right, and the sky lines up
// with what the phone is pointed at. The manual trim that existed to recover from
// either being wrong is gone.
//
// NOT VERIFIED ON ANDROID, where `webkitCompassHeading` does not exist and
// `deviceorientation`'s alpha is referenced to an arbitrary zero. North comes from
// `deviceorientationabsolute` there instead. Where neither source is available the
// sky view refuses to aim by compass rather than aiming at an arbitrary azimuth —
// see docs/adr/0004-compass-aiming.md.
//
// Note this needs a secure context, so it cannot be exercised over
// `pnpm dev:host` on a LAN address; it wants a tunnel or a preview deploy.
//
// The device frame is the one `deviceorientation` defines: with the phone flat,
// screen up and its top edge pointing north, the device's X is east, Y is north
// and Z is up — the same axes as the observer's east-north-up frame, so at
// alpha = beta = gamma = 0 the rotation is the identity.

import { Cartesian3, Math as CesiumMath, Matrix3 } from "@cesium/engine";

import { type Aim, normalizeAzimuth, rollOf } from "./skyGeometry";

export { normalizeAzimuth } from "./skyGeometry";

export interface DeviceOrientationSample {
  /** Rotation about the vertical, 0-360. Relative to an arbitrary zero on iOS. */
  alpha: number;
  /** Front-to-back tilt, -180 to 180. */
  beta: number;
  /** Left-to-right tilt, -90 to 90. */
  gamma: number;
  /** `screen.orientation.angle` — how far the content is rotated from natural. */
  screenAngle: number;
}

/**
 * How near horizontal the screen must be before iOS's compass heading is worth
 * believing. The `360 - webkitCompassHeading` workaround is only valid with the
 * phone flat; as it tilts the two diverge, and with the phone pointed near the
 * zenith the projected heading of the top edge swings by ~180°, which would
 * spin the whole sky.
 */
const COMPASS_POSTURE_TOLERANCE = 35;

const BACK_CAMERA: Cartesian3 = new Cartesian3(0, 0, -1);
const SCREEN_UP: Cartesian3 = new Cartesian3(0, 1, 0);
const SCREEN_NORMAL: Cartesian3 = new Cartesian3(0, 0, 1);

/**
 * The device's rotation, taking device-frame vectors into east-north-up.
 *
 * Intrinsic Z-X'-Y'', the order `deviceorientation` specifies. The screen
 * rotation is about the device's own Z and comes last, because it turns the
 * *display* without turning the hardware.
 */
function deviceRotation({ alpha, beta, gamma, screenAngle }: DeviceOrientationSample): Matrix3 {
  const rotation = Matrix3.multiply(
    Matrix3.multiply(Matrix3.fromRotationZ(CesiumMath.toRadians(alpha)), Matrix3.fromRotationX(CesiumMath.toRadians(beta)), new Matrix3()),
    Matrix3.fromRotationY(CesiumMath.toRadians(gamma)),
    new Matrix3(),
  );
  return Matrix3.multiply(rotation, Matrix3.fromRotationZ(CesiumMath.toRadians(-screenAngle)), rotation);
}

/**
 * The aim a device orientation implies, before any compass correction: the
 * azimuth is measured from `alpha`'s zero, which on iOS drifts and is arbitrary.
 */
export function aimFromDeviceOrientation(sample: DeviceOrientationSample): Aim {
  const rotation = deviceRotation(sample);
  // The rear camera looks out of the back of the screen, along -Z; the top of
  // the display is +Y. Both are device-frame vectors rotated into the world.
  const direction = Matrix3.multiplyByVector(rotation, BACK_CAMERA, new Cartesian3());
  const screenUp = Matrix3.multiplyByVector(rotation, SCREEN_UP, new Cartesian3());

  const pitch = CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(direction.z, -1, 1)));
  const azimuth = normalizeAzimuth(CesiumMath.toDegrees(Math.atan2(direction.x, direction.y)));
  // Decomposed against the same level pair `skyBasis` composes with, so the two
  // are exact inverses — see skyGeometry. Projecting rather than reading an
  // Euler angle is what keeps this defined with the phone pointed straight up.
  return { azimuth, pitch, roll: rollOf(azimuth, pitch, screenUp) };
}

/** Whether the screen is flat enough for iOS's compass heading to mean anything. */
export function compassIsMeaningful(sample: DeviceOrientationSample): boolean {
  // Screen normal is +Z in the device frame; flat means it is near vertical,
  // either face up or face down. The screen angle cannot change that, so it is
  // left out rather than cancelled.
  const rotation = deviceRotation({ ...sample, screenAngle: 0 });
  const screenNormal = Matrix3.multiplyByVector(rotation, SCREEN_NORMAL, new Cartesian3());
  const tiltFromHorizontal = CesiumMath.toDegrees(Math.acos(CesiumMath.clamp(Math.abs(screenNormal.z), -1, 1)));
  return tiltFromHorizontal <= COMPASS_POSTURE_TOLERANCE;
}

/**
 * The yaw offset that carries an alpha-relative azimuth onto true north.
 *
 * Applied about world up and held between refreshes, rather than folded into
 * `alpha`: the usual `360 - webkitCompassHeading` substitution is a statement
 * about the phone lying flat, and applying it continuously is what makes the sky
 * spin as the device tilts.
 */
export function compassYawOffset(sample: DeviceOrientationSample, compassHeading: number): number {
  return normalizeAzimuth(360 - compassHeading - sample.alpha);
}

/** Where a sample's idea of north came from, if anywhere. */
export interface HeadingReading {
  /** Safari's compass heading. Absent everywhere else. */
  compassHeading?: number | undefined;
  /** Whether the sample's own alpha is already referenced to true north. */
  absolute?: boolean;
}

/** Whether a reading can establish north at all, whatever the current posture. */
export const hasHeadingSource = (reading: HeadingReading): boolean => reading.absolute === true || reading.compassHeading !== undefined;

/** Tracks the yaw offset, refreshing it only from readings that justify it. */
export class CompassCalibration {
  #offset = 0;

  #calibrated = false;

  get calibrated(): boolean {
    return this.#calibrated;
  }

  update(sample: DeviceOrientationSample, reading: HeadingReading): void {
    // An absolute reading needs no correction and no particular posture: alpha is
    // already measured from north, so the offset is zero and known to be right.
    if (reading.absolute) {
      this.#offset = 0;
      this.#calibrated = true;
      return;
    }
    if (reading.compassHeading === undefined || !compassIsMeaningful(sample)) {
      return;
    }
    this.#offset = compassYawOffset(sample, reading.compassHeading);
    this.#calibrated = true;
  }

  /** Correct a device-relative aim onto true north. */
  correct(aim: Aim): Aim {
    return { ...aim, azimuth: normalizeAzimuth(aim.azimuth + this.#offset) };
  }
}

// Turning a phone's orientation into an aim for the sky view.
//
// UNVERIFIED ON HARDWARE. `DeviceOrientationEvent` needs a secure context, so
// this cannot be exercised over `pnpm dev:host` on a LAN address — it wants a
// tunnel or a preview deploy. The geometry below is tested, but the two
// conventions that only a device can settle are called out where they are used:
// the sign of the screen-orientation correction, and whether iOS's
// `webkitCompassHeading` lines up with `alpha` the way the usual workaround
// assumes. The manual trim exists because of exactly that.
//
// The device frame is the one `deviceorientation` defines: with the phone flat,
// screen up and its top edge pointing north, the device's X is east, Y is north
// and Z is up — the same axes as the observer's east-north-up frame, so at
// alpha = beta = gamma = 0 the rotation is the identity.

import { Math as CesiumMath } from "@cesium/engine";

import type { Aim } from "./SkyView";

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

type Vector = [number, number, number];

const multiply = (a: number[], b: number[]): number[] => {
  const out = Array.from<number>({ length: 9 }).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += (a[row * 3 + k] as number) * (b[k * 3 + column] as number);
      }
      out[row * 3 + column] = sum;
    }
  }
  return out;
};

const apply = (m: number[], v: Vector): Vector => [
  (m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2],
  (m[3] as number) * v[0] + (m[4] as number) * v[1] + (m[5] as number) * v[2],
  (m[6] as number) * v[0] + (m[7] as number) * v[1] + (m[8] as number) * v[2],
];

const rotateX = (radians: number): number[] => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};

const rotateY = (radians: number): number[] => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};

const rotateZ = (radians: number): number[] => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Wrap to [0, 360). */
export const normalizeAzimuth = (degrees: number): number => ((degrees % 360) + 360) % 360;

/**
 * The aim a device orientation implies, before any compass correction: the
 * azimuth is measured from `alpha`'s zero, which on iOS drifts and is arbitrary.
 */
export function aimFromDeviceOrientation(sample: DeviceOrientationSample): Aim {
  const { alpha, beta, gamma, screenAngle } = sample;
  // Intrinsic Z-X'-Y'', the order `deviceorientation` specifies. The trailing
  // screen rotation is about the device's own Z, so it commutes with nothing and
  // has to come last — it turns the *display* without turning the hardware.
  const rotation = multiply(
    multiply(multiply(rotateZ(CesiumMath.toRadians(alpha)), rotateX(CesiumMath.toRadians(beta))), rotateY(CesiumMath.toRadians(gamma))),
    rotateZ(CesiumMath.toRadians(-screenAngle)),
  );

  // The rear camera looks out of the back of the screen, along -Z; the top of
  // the display is +Y. Both are device-frame vectors rotated into the world.
  const direction = apply(rotation, [0, 0, -1]);
  const screenUp = apply(rotation, [0, 1, 0]);

  const elevation = CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(direction[2], -1, 1)));
  const azimuth = normalizeAzimuth(CesiumMath.toDegrees(Math.atan2(direction[0], direction[1])));

  // Roll is what the screen's up does relative to a level view along the same
  // axis. Derived by projecting onto the unrolled pair rather than from an Euler
  // angle, so it stays defined when the phone points straight up.
  const az = CesiumMath.toRadians(azimuth);
  const el = CesiumMath.toRadians(elevation);
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  const levelUp: Vector = [-sinAz * Math.sin(el), -cosAz * Math.sin(el), Math.cos(el)];
  const levelRight: Vector = [cosAz, -sinAz, 0];
  const roll = CesiumMath.toDegrees(Math.atan2(dot(screenUp, levelRight), dot(screenUp, levelUp)));

  return { azimuth, elevation, roll };
}

/** Whether the screen is flat enough for iOS's compass heading to mean anything. */
export function compassIsMeaningful(sample: DeviceOrientationSample): boolean {
  // Screen normal is +Z in the device frame; flat means it is near vertical,
  // either face up or face down.
  const rotation = multiply(multiply(rotateZ(CesiumMath.toRadians(sample.alpha)), rotateX(CesiumMath.toRadians(sample.beta))), rotateY(CesiumMath.toRadians(sample.gamma)));
  const screenNormal = apply(rotation, [0, 0, 1]);
  const tiltFromHorizontal = CesiumMath.toDegrees(Math.acos(CesiumMath.clamp(Math.abs(screenNormal[2]), -1, 1)));
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

/** Tracks the yaw offset, refreshing it only from postures that justify it. */
export class CompassCalibration {
  #offset = 0;

  #calibrated = false;

  #trim = 0;

  get calibrated(): boolean {
    return this.#calibrated;
  }

  get trim(): number {
    return this.#trim;
  }

  /** The escape hatch: always available, and always added on top. */
  set trim(degrees: number) {
    this.#trim = degrees;
  }

  update(sample: DeviceOrientationSample, compassHeading: number | undefined): void {
    if (compassHeading === undefined || !compassIsMeaningful(sample)) {
      return;
    }
    this.#offset = compassYawOffset(sample, compassHeading);
    this.#calibrated = true;
  }

  /** Correct a device-relative aim onto true north. */
  correct(aim: Aim): Aim {
    return { ...aim, azimuth: normalizeAzimuth(aim.azimuth + this.#offset + this.#trim) };
  }
}

---
status: accepted
---

# Compass aiming needs true north, or it does not happen

The sky view can hand its aim to the device's orientation sensor, which reports a yaw
about the vertical (`alpha`) that is measured from an arbitrary zero. Turning that into
a real azimuth needs a heading reference, and there are exactly two: Safari's
`webkitCompassHeading`, and Chrome's earth-referenced `deviceorientationabsolute`. On a
device that offers neither, compass aiming **refuses to start** and says why, rather
than aiming from a bearing nobody measured.

## Decision

Where an absolute reading is available it is used directly: `alpha` is already measured
from north, so the correction is zero and known-good at any posture. Where only
`webkitCompassHeading` exists, the offset is computed from it — but only while the
screen is near horizontal, because the `360 - heading` substitution is a statement about
a phone lying flat and applying it continuously makes the sky spin as the device tilts.
That is why north is not known the instant the compass is switched on, and why the HUD
carries a note until it is.

The manual trim slider that used to sit on the HUD is gone. It existed because two
conventions were unverified — the sign of the screen-orientation correction, and whether
`webkitCompassHeading` lines up with `alpha` as the workaround assumes — and iOS hardware
has settled both with the trim at zero. Keeping it would mean shipping a control whose
only remaining purpose is to ask the user to guess a bearing.

`enableDeviceOrientation` therefore reports which of five things happened —
aiming, aiming-but-not-yet-calibrated, unsupported, denied, granted-but-silent, or
no-heading — rather than a boolean, because those need different words in front of a
person: a laptop has no sensor to grant, a declined permission can be asked for again,
and a device with no magnetometer is not going to acquire one.

## Consequences

- **Android is unverified.** The absolute path is written against the specification, not
  against hardware, and `DeviceOrientationEvent` needs a secure context so it cannot be
  exercised over `pnpm dev:host`. The refusal is what keeps that honest: an untested
  path either produces a real heading or declines.
- **A silent sensor is a refusal too.** Desktop browsers define the event and grant it
  happily, then never fire it, so the sensor is given 1200 ms to prove itself before the
  aim is handed over. Accepting the grant would freeze the view.
- **`absolute` is trusted only from the absolute event.** `deviceorientation` sets the
  flag as well, to false, and reading that as a claim about iOS's heading would suppress
  the `webkitCompassHeading` path entirely.
- **This is the same rule ADR-0003 applied to the observer** — the sky view does not open
  at a fallback location either. A sky full of satellites in the wrong places looks like
  a working feature, which is worse than a control that declines and explains itself.

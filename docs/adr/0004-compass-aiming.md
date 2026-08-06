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

### A drag takes the aim back

Dragging while the compass is aiming turns the compass off and then drags, rather
than being ignored.

There is no third option. The sensor writes the aim on every reading, so a drag
that merely nudged it would be erased within about 60 ms — a gesture that visibly
does nothing, and the only reading a user has for it is that the compass is
broken. Nothing short of unsubscribing can share the aim.

The threshold is the tap slop the selection already uses, not the first pixel: a
tap is how a satellite is chosen, and the hand tremor inside one must not cost the
compass. The movement keys are the same trade from the other side — walking moves
the observer and never touches the aim, so it leaves the compass alone.

Handing back **levels the view**. Nothing but the sensor ever rolls the sky view,
so a roll left behind is one the pointer cannot straighten, and a horizon frozen at
whatever angle the phone was held at does not read as a held angle — it reads as a
broken view. So `disableDeviceOrientation` levels it, whoever asked: the control,
a drag, or the view closing.

The awkward case is a drag during the 1200 ms sensor probe, where the aim is
already being written but the outcome has not been decided. Reporting "aiming"
there would leave the control claiming a compass that is off, so the probe checks
whether the aim is still its own before answering. That is what `taken-back`
answers, and it is the one outcome with nothing to say in front of the user: the
user is the one who ended it.

`enableDeviceOrientation` therefore reports which of these happened — aiming,
aiming-but-not-yet-calibrated, unsupported, denied, granted-but-silent, no-heading,
or taken-back — rather than a boolean, because those need different words in front of
a person: a laptop has no sensor to grant, a declined permission can be asked for
again, a device with no magnetometer is not going to acquire one, and a person who
took the aim by hand needs telling none of it.

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

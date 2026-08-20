---
status: accepted
---

# The sky view is a view mode, and it owns the camera

Pointing a phone at the sky and identifying what is passing overhead is the same
scene the globe already draws, seen from a different place. So it is not a second
renderer, not a route, and not a separate app: the existing Cesium camera is parked
on the ellipsoid at the observer and aimed upward, and the satellites are the
entities that were there anyway. Rendering, metadata, pass prediction, the shared
clock and `viewer.selectedEntity` → `EntityInfoPanel` all come along unchanged.

That leaves two questions this ADR answers: where the mode lives, and what happens
to the other things that want to drive the camera.

## Decision

### Sky is a fourth view mode

`SCENE_MODES` becomes `["3D", "2D", "Columbus", "Sky"]`, carried in the existing
`scene` parameter as `?scene=Sky`.

The alternative was a separate `skyView` store key on a new `view` parameter, kept
orthogonal to `scene` on the grounds that "which projection" and "where am I
standing" are different questions. They are — but they are not _independent_: a
ground-level camera in a 2D projection is meaningless, so two parameters would have
needed a rule forbidding half their combinations. One radio group cannot express an
illegal combination in the first place.

Reusing `scene` also means the mode arrives fully wired. `SCENE_MODES` has exactly
three consumers — the store's `enumString`, the radio group's `cc.sceneModes`, and
`set sceneMode` — so the parameter, its validation and its control are one tuple
edit, and `?scene=banana` already falls back to the default.

The cost is that `cesiumStore.sceneMode` no longer names a Cesium `SceneMode`: in
sky view the store says `Sky` while `viewer.scene.mode` is `SCENE3D`. That is
harmless because every `SCENE3D` test in the codebase reads Cesium's enum directly
and none reads the store string — and it is correct, because the sky view _is_ 3D.
`src/config/viewModes.ts` is the app's own view vocabulary, three of whose members
happen to coincide with Cesium's.

### The observer is a ground station, designated

The sky view looks up from a point on the ground, and the app already has a name for
such a point. Reusing it means `?scene=Sky&gs=48.14,11.58` is a complete, shareable
"what is over me right now", and the detail card's next-pass figures are the pass
prediction that was already being computed — rather than a second location concept
that would have to explain which of the two a countdown belongs to.

_Which_ station was originally the first one, making the list order load-bearing.
It is now a designation held beside the list (`sat.observerStation`, default 0), so
that entering the sky view from a particular station — the button on its info panel
— says so by designating it rather than by rearranging somebody's list. Three places
read the designation and they have to agree: entry (`resolveObserver`), the watcher
that moves a live view when the station moves, and the walk that writes back. The
designation is deliberately not a url parameter: a link carries the stations and the
view mode, and the observer among them is the first one, exactly as before. Adding a
parameter would extend the contract in ADR 0001 and is a separate decision.

Entry is therefore an action gated on an observer existing, not a watcher: with no
ground station the device's own location becomes one, and the sky view does not open
if that is refused. Opening at a fallback location would be worse than not opening,
because a sky full of satellites at coordinates the user never chose looks like a
working feature.

### Walking moves the ground station, once the keys stop

`WASD` walks the observer across the ground, `E` and `Q` raise and lower the eye,
and shift multiplies the speed. Forward is the aim's azimuth with its pitch
discarded: the sky view spends its time looking up, so moving along the view axis
would fly the observer into the sky rather than across the ground, which is what
the two height keys are for.

Because the observer _is_ a ground station, a walk has to end up there — the map
pin, the next-pass figures and `?gs=` all follow the same point, and a private
"where the camera is standing" would be the second location concept this ADR
rejected above. The walked station keeps its place in the list as well as its name:
a walk is a move, not a reordering. But a station move recomputes every active satellite's passes
and pushes a url entry, which is not something to do sixty times a second. So the
two halves run at different rates: `SkyView.moveObserver` moves the view every
frame, and `SkyMovement` reports the observer to the store once the keys have been
still for 350 ms. One walk is one station move, one recomputation and one history
entry, whatever it was made of.

The ground under a walk is measured on a throttle — every 250 ms, five metres of
walking or forty of sprinting — with one unthrottled measurement when the keys
stop. `enter` can afford to measure outright because it is one move; a walk cannot
afford a request per frame, and measuring nothing at all leaves the eye at the
height it set off from, which is underground the moment the walk heads uphill.

What a walk must **not** do is fall back to `globe.getHeight`. That is free and
follows the terrain per frame, which is why it is the fallback of last resort when
nothing has measured yet — but it answers about the globe, and under a surface
model the globe is not what is being stood on. Under the photorealistic mesh it is
not drawn at all, and its ellipsoid answers 0 plausibly enough to pass the
plausibility guard, which puts the eye hundreds of metres inside the mesh. That is
the failure `docs/manual-verification.md` records as the world turning inside out,
and it was reached from a single keypress.

Height above the ground is deliberately **not** in the url. The wire format's
ground station is a point on the ground that passes are computed against, and
passes are computed there whether the eye is at 2 m or 500; adding a third
coordinate would put a number into the pass predictor's input that the pass
predictor has no use for. The eye height is the view's, and it resets on entry
along with the aim and the zoom.

### Inertial is suppressed; tracking is cleared

Three things want to write the camera every frame, and the sky view cannot share it
with any of them.

`cameraMode: "Inertial"` re-parents the camera on every `postUpdate`, so a one-time
`lookAtTransform(Matrix4.IDENTITY)` is undone on the next tick. It is **suppressed**:
the listener is detached on entry and re-attached on exit, while the store and
`?camera=Inertial` are untouched. This is the pattern `set sceneMode` already uses
for the Orbit component during a morph — the user's choice stands, the scene declines
to honour it for a while.

Tracking is **cleared** instead, and as an invariant rather than an event: while sky
is the view mode nothing is tracked and any attempt to track is undone. Suppression
was the symmetric option, but tracking has no meaning that survives the trip — the
camera cannot both follow a satellite and be a pair of eyes on the ground — and an
invariant is the only form that covers `?scene=Sky&track=X` arriving whole at
hydration, where there is no entry moment to hang an event off, and
`pendingTrackedSatellite` resolving minutes later when its group finishes loading.

The consequence is a written exception to "leaving restores the globe exactly": the
tracked satellite is deliberately not restored. Giving tracking a sky-native meaning
— an on-sky target with a guidance arc — is left to the pass-timeline work.

Note that clearing must be done by writing `satStore.trackedSatellite`, never by
assigning `viewer.trackedEntity`. Tracking is the one value the globe reports _back_,
so poking Cesium reaches the store through `#onTrackedChange` and races the forward
path.

### Vertical FOV is the contract

Cesium's `PerspectiveFrustum.fov` is the horizontal angle when the viewport is wider
than tall and the vertical angle otherwise. Every quantity the sky view cares about
is vertical — whether the horizon is on screen at a given pitch, and whether the
overlay registers with a camera image — so the vertical angle is what is stored, and
Cesium's `fov` is derived from the live aspect ratio and recomputed when it changes.

Defaults are `fovy = 75°` and `pitch = 30°`, the same on every device, and the
guarantee they exist to provide is **`pitch < fovy/2`** **on entry** — which is why
there are no per-orientation numbers and no pixel arithmetic to go stale.

That is a statement about the defaults and not a standing invariant. Wheel and pinch
now move `fovy` within 10–100°, and zooming in on something high in the sky is
_supposed_ to take the horizon off screen; clamping pitch to preserve the inequality
would silently tilt the view down as the user zoomed. The range is clamped in the
`fovy` setter rather than at each gesture, because it is a property of the view and
not of the input that moved it.

Zoom changes the field of view and nothing else — no zoom-to-cursor. Recentring works
by moving the aim, and under device-orientation aiming the sensor overwrites the aim
on its next reading, so the recentring would visibly snap back; screen-centre is the
only rule that behaves identically under a drag and under the sensor.

### Entering and leaving are flights, not cuts

The camera is flown between the globe pose and the ground pose over 2.2 s rather
than being assigned outright (`src/modules/skyFlight.ts`).

This is not decoration. The claim the whole view mode rests on is that this is the
same scene from a different place, and a cut is exactly the edit that says
otherwise: the globe and a sky full of satellites share too few pixels for the eye
to connect them, so switching read as arriving somewhere else. The flight is what
carries the connection.

`camera.flyTo` cannot supply it, for the same reason `camera.setView` cannot place
the camera: it routes orientation through heading/pitch/roll and mirrors the sky
near the zenith. The blend is therefore ours, and the attitude goes through a
quaternion rather than three separately interpolated vectors — a lerp of three unit
vectors is not orthonormal in between, and Cesium's camera renders whatever basis
it is handed.

### The flight has three legs, because two poses are not a journey

Interpolating the endpoints and nothing else is not enough to make the claim above.
Blended straight, the attitude reaches sky-like within a few hundred milliseconds,
the globe leaves the frame, and the rest of the descent is spent looking at empty
sky while the position quietly travels — a flight that shows the departure and the
arrival and says nothing about where it is going. So one clock drives three legs:

1. **Lock on** (first 30%). The view swings from wherever it was onto the observer.
   Early, because this is the leg that answers "where is this going", and because
   the position has barely moved by then so it reads as a pan rather than a lurch.
2. **Descend** (to 55%). The observer is held at the exact centre of the screen and
   grows as the camera closes on it, coming to rest **directly overhead**, looking
   down. Since the observer is a ground station, its map pin is already drawn
   there — the destination is not merely centred, it is labelled.
3. **Rise** (last 45%). The camera drops the last of the way, lands at 80%, and the
   view sweeps up off the ground, past the horizon, to the aim.

Coming to rest overhead before landing is a correctness requirement as much as a
picture. A swoop that arrives along its own great-circle tangent reaches the ground
travelling sideways, and an aim tracking the observer then whips through the last
few metres — measured at 10° in a single frame before the legs were split. Arriving
vertically makes the descent's aim reach straight down smoothly, which is also
exactly where the rise starts.

That is why the rise is expressed as `skyBasis` at a pitch of -90° rather than as
any convenient nadir: built from the same aim, the whole leg is a change of pitch
and nothing else, so no roll creeps in and the view arrives facing the direction it
spent the descent facing. `skyBasis` being continuous through straight down — the
property the zenith tests already pin down — is what makes -90° an aim like any
other.

The aim itself is built by turning the straight-down attitude onto the line of
sight, not by crossing the view axis with an up vector. A cross-product look-at has
no answer when the camera is directly overhead, which is precisely where this
flight ends; turning makes that case the identity rotation, so the aim stays
defined once the camera is standing on the very point it is aiming at.

Three consequences follow:

- **`active` and `settled` are different questions.** The view owns the camera for
  the whole of both flights (`active`), but only once it has landed does the aim
  describe what is on screen (`settled`). The HUD's tapes and the crosshair read
  `settled` — projected against a camera still somewhere over the Atlantic they
  would swim across the viewport — and the overlay fades up as the ground arrives.
- **The interaction starts on landing.** Dragging and the device sensor both write
  the aim, and the aim is the flight's destination, so a gesture during the descent
  would steer it rather than move a view that has arrived.
- **Leaving is the same flight played backwards.** One path, one clock and a sign,
  so the trip out retraces the trip in — look down at your feet, take off, swing
  away — and there is no second schedule to keep in step with the first. It also
  makes turning around free: a switch back mid-flight flips the sign and resumes
  from the progress already made, so the camera carries on from where it is
  instead of snapping to an end it is nowhere near.
- **Exit is asynchronous.** `exit()` returns a promise, and morphing the projection
  or releasing the camera mode has to wait for it — until the flight lands the
  camera is still the sky view's — so the pair of clicks cannot leave the globe
  half-restored.

Anyone who has asked for reduced motion gets the cut this replaced, in full: the
duration goes to zero and the camera is assigned outright, which is the honest
reading of that request rather than a brisker version of the same movement.

## Consequences

- **Restore what you changed, and only that.** `set background(false)` destroys the
  skybox, sun, moon and atmosphere irreversibly, so a blanket "restore the sky
  objects" is unsatisfiable after `?bg=false`. The sky view hides them only when
  camera passthrough is on — with no camera feed the skybox is the correct backdrop
  anyway — which makes the two compose with no special case.
- **No `scene.pick`.** The crosshair takes the Euclidean nearest satellite within its
  capture radius from projected screen positions, which the HUD computes for the
  tapes regardless, and assigns that entity to `viewer.selectedEntity` directly. The
  pick rectangle is in drawing-buffer pixels while the capture radius is in CSS
  pixels, so a pick-based crosshair would silently change reach by 3× with the
  quality preset. Occlusion becomes an explicit horizon test plus a terrain ray
  (`groundHides`), shared with the orbit trace, which needs both anyway. The ray is
  what keeps the crosshair agreeing with the picture, which is depth-tested against
  the terrain (`SkyView#enter`): without it a satellite behind a ridge is hidden and
  still lockable. It is asked nearest-candidate-first and only until one is visible,
  so the ordinary frame spends one ray rather than one per satellite in the sky.
- **The capture radius stays in CSS pixels**, so its angular reach falls out of the
  zoom: ±5.3° at the default on an 844px-tall phone, ±0.71° at maximum zoom. That
  is deliberate — zooming in _is_ the mechanism for choosing between two satellites
  that share the reticle, which a radius pinned in degrees would defeat.
- **The ground stays opaque.** The alternative was a translucent globe, which would
  show a camera feed through the earth — but it would also leak the satellites the
  earth is supposed to be hiding, and correct occlusion is worth more than seeing
  the real ground through a view whose whole job is to say what is above you. This
  is a decision, not a default: revisit it only if passthrough makes an opaque
  lower half untenable.
- **`minimalUI` hides the clock and timeline on iOS**, so the shared-clock benefit is
  desktop-only and the sky view is live-time on the device it was designed for.
  _Superseded:_ the clock deck now stands in for both widgets on every device, so
  the clock is as controllable from the sky view on a phone as anywhere else
  (CONTEXT.md, **Clock deck**).
- **The overlay's click-through is verified by hand**, not by a test — jsdom has no
  layout, so `elementFromPoint` cannot answer there. The procedure and its result
  are in `docs/manual-verification.md`; a browser-driven test would replace it.

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

### The observer is the first ground station

The sky view looks up from a point on the ground, and the app already has a name for
such a point. Reusing it means `?scene=Sky&gs=48.14,11.58` is a complete, shareable
"what is over me right now", and the detail card's next-pass figures are the pass
prediction that was already being computed — rather than a second location concept
that would have to explain which of the two a countdown belongs to.

Entry is therefore an action gated on an observer existing, not a watcher: with no
ground station the device's own location becomes one, and the sky view does not open
if that is refused. Opening at a fallback location would be worse than not opening,
because a sky full of satellites at coordinates the user never chose looks like a
working feature.

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
now move `fovy` within 10–90°, and zooming in on something high in the sky is
_supposed_ to take the horizon off screen; clamping pitch to preserve the inequality
would silently tilt the view down as the user zoomed. The range is clamped in the
`fovy` setter rather than at each gesture, because it is a property of the view and
not of the input that moved it.

Zoom changes the field of view and nothing else — no zoom-to-cursor. Recentring works
by moving the aim, and under device-orientation aiming the sensor overwrites the aim
on its next reading, so the recentring would visibly snap back; screen-centre is the
only rule that behaves identically under a drag and under the sensor.

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
  quality preset. Occlusion becomes an explicit horizon test, shared with the orbit
  trace, which needs it anyway.
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
- **The overlay's click-through is verified by hand**, not by a test — jsdom has no
  layout, so `elementFromPoint` cannot answer there. The procedure and its result
  are in `docs/manual-verification.md`; a browser-driven test would replace it.

# Manual verification

Checks that cannot be automated with the current test setup, written down so the
result is a record rather than a memory. Each one says what was checked, how, and
what it returned — rerun it when the code it covers changes.

`pnpm test` runs in jsdom, which has no layout engine: it cannot answer
`getBoundingClientRect`, `elementFromPoint`, or anything about stacking. A
browser-driven test runner would replace this file; until then it is the record.

## Sky view: the HUD does not swallow clicks

**Why it cannot be a unit test.** The HUD is a transparent full-viewport layer, so
a control it covers still _looks_ fine — the failure is invisible and only a real
hit test finds it. `#cesiumContainer` is a sibling before `#app`, and `#app`
isolates its stacking context, so no z-index can lift Cesium's own widgets above
anything rendered inside the app. The arrangement that works is HUD root at `z-4`
with `pointer-events: none`, app toolbars at `z-6`, `.entity-info-panel` at `z-5`,
and look-around listening on the Cesium canvas rather than on an overlay.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800`, wait for the scene to settle,
then for each control take its bounding box, call `document.elementFromPoint` at
the centre, and assert the control contains what comes back.

```js
[
  ["toolbar Map", "#toolbarLeft .toolbarButtons button:nth-child(4)"],
  ["toolbar eye", "#toolbarRight button"],
  ["cesium credits", ".cesium-credit-logoContainer"],
  ["cesium timeline", ".cesium-timeline-bar"],
  ["cesium clock", ".cesium-viewer-animationContainer"],
  ["entity info panel", ".entity-info-panel"],
].map(([name, selector]) => {
  const el = document.querySelector(selector);
  if (!el) return [name, "not present on this platform"];
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return [name, el.contains(hit) ? "clickable" : `BLOCKED by ${hit?.className || hit?.tagName}`];
});
```

The entity info panel needs a selection first — `cc.viewer.selectedEntity =
cc.sats.activeSatellites[0].defaultEntity`.

**Result, 2026-07-27, Chrome, desktop viewport 1618x1576.** All six clickable.
Note that `minimalUI` (in an iframe, or on iOS) removes the clock and timeline
entirely, so on those platforms the check covers only the controls that exist.

Since the compass control moved to the View menu the HUD holds nothing interactive
at all, which makes the arrangement above easier to keep rather than harder.

## Sky view: the zoom gestures

**Why it cannot be a unit test.** The clamp and the curve are unit-tested; what is
not is that a wheel or a pinch reaches the handler and moves only the field of view.
That needs real event dispatch against a live canvas.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800`, then dispatch synthetic
`WheelEvent`s and `PointerEvent`s at `cc.viewer.scene.canvas`, reading
`cc.skyView.fovy` and `cc.skyView.aim` between them. Two fingers 100px apart
widening to 200px should halve the field of view; the aim must be identical before
and after.

**Result, 2026-07-28, Chrome.** Wheel: 75° → 55.561° → 41.161° on equal notches
(constant ratio, i.e. multiplicative), and −200/−200/+400 returns to exactly 75°.
Clamps at 10° and 90°. A `deltaMode: 1` line delta of −3 steps 75° → 69.79°, so
Firefox-style deltas are not a no-op. Pinch: 60° → 30° at 2× separation and → 20°
at 3×, computed from the gesture start rather than accumulated. The aim was
byte-identical across every wheel notch and through the whole pinch, and a drag
after the second finger lifted moved the aim without a jump.

Note that a hidden browser tab reports `clientWidth/clientHeight` of 0 and never
fires `requestAnimationFrame`, so Cesium's render loop stalls and the globe stays
blank — drive `scene.render()` by hand when checking anything visual this way.

## Layers: the offline imagery fallback

**Procedure.** Move `data/cesium-assets/imagery/NaturalEarthII/tilemapresource.xml`
aside to simulate an unpopulated submodule, reload, then put it back.

**Result, 2026-07-28, Chrome.** The base layer became
`/cesium/Assets/Textures/NaturalEarthII/...` (the bundled set), the url was rewritten
to `?layers=Offline`, and the console carried the warning naming
`git submodule update --init`. With the file present the high-resolution provider is
used and the globe tiles normally.

## Sky view: what a device is still needed for

Open questions 1 and 2 in `docs/adr/0003-sky-view.md` need a real phone on HTTPS —
`getUserMedia` and `DeviceOrientationEvent.requestPermission` both demand a secure
context, so `pnpm dev:host` over a LAN address cannot exercise them. Use a tunnel
or a preview deploy. Camera passthrough is not implemented.

Device orientation **is verified on iOS**: the sign of the screen-orientation
correction and the `360 - webkitCompassHeading` substitution are both right, and the
sky lines up with what the phone is pointed at with no manual trim. What remains
unverified is the Android path — `deviceorientationabsolute` — which is written
against the specification only. See `docs/adr/0004-compass-aiming.md` for why an
untested heading source is required to either work or decline.

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

## Sky view: what a device is still needed for

Open questions 1 and 2 in `docs/adr/0003-sky-view.md` need a real phone on HTTPS —
`getUserMedia` and `DeviceOrientationEvent.requestPermission` both demand a secure
context, so `pnpm dev:host` over a LAN address cannot exercise them. Use a tunnel
or a preview deploy. Camera passthrough is not implemented. Device orientation is,
with tests covering the geometry, but the sign of the screen-orientation
correction and the behaviour of iOS's `webkitCompassHeading` are unconfirmed.

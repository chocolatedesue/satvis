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
blank — drive `scene.render()` by hand when checking anything visual this way. A
hidden tab also will not restyle a pseudo-element for a `checked` property set from
script, so a switch's slider colour cannot be read that way; check the `checked`
property instead, or take a screenshot, which fronts the pane.

## Sky view: the compass tape holds its scale

**Why it cannot be a unit test.** `headingOffset` is unit-tested against a
from-scratch projection, including the `1/cos(pitch)` divergence it exists to avoid.
What that cannot show is the tape staying legible while a live view is dragged
upward.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800`, then step
`cc.skyView.look({ pitch })` through 0, 30, 60 and 85 and read the tick offsets out
of the HUD, checking the spacing between adjacent ticks does not change.

**Result, 2026-07-29, Chrome.** Spacing constant at every pitch, and the tape keeps
its marks pointing at the zenith. Before the change, 15° of azimuth spanned 147 px at
eye level and 1691 px at 85° of pitch, and the visible window collapsed from ±15° to
nothing.

## Worker: missing files 404, and none of it is billed

**Why it matters.** `not_found_handling: "single-page-application"` answered every
unmatched path with `index.html` and a 200, which is what made `response.ok` meaningless
for the imagery probe and let the service worker cache the app shell under tile urls. The
constraint on any fix is that it must not turn asset traffic into billed Worker
invocations.

**Procedure.** `pnpm build`, `pnpm dev:worker`, then request each path and read the status.
For the billing half, put `console.log("BILLED", new URL(request.url).pathname)` at the top
of the Worker's `fetch` and watch which requests appear.

**Result, 2026-07-30, wrangler dev on the built dist.**

| path                                     | status                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `/`, `/ot`                               | 200 text/html                                                            |
| `/embedded.html`, `/test.html`           | 307 to `/embedded`, `/test` (asset router `html_handling`, pre-existing) |
| `/typo-route`                            | 404 text/html (the 404 page)                                             |
| `/api/groups.json`                       | 200 application/json                                                     |
| `/cesium/…/tilemapresource.xml` (exists) | 200 application/xml                                                      |
| `/data/imagery/…` (a missing tile)       | **404**                                                                  |
| `/data/gp/weather.json` (absent)         | **404**                                                                  |

Of those six requests, **only `/api/groups.json` logged `BILLED`** — routes, unknown paths
and missing files are all answered by the asset router. Two combinations that are _not_
free, both measured: `404-page` with no `404.html` falls through to the Worker, and
`not_found_handling: "none"` invokes it for every unmatched path.

`/ot` returning 200 depends on the `_redirects` rewrite `/ot / 200`. Two details it is
easy to get wrong, both found by testing: the target must be `/` and not `/index.html`,
because the asset router strips the extension and answers with a 307 to `/`, which would
send the route to the default preset; and wrangler warns that a static rule placed after a
dynamic one cannot be matched as cheaply, so it goes above the splat rule.

**A trap when checking this in a browser.** The app writes its state into the query, so
re-visiting the bare path in the same tab can land on the previously written url — `/ot`
became `/ot?layers=Offline` from an earlier visit, which looked exactly like the OT preset
failing to apply. Navigate with a distinct query (`/ot?v=clean`) to be sure of a fresh
state. Verified that way: `/ot` selects VersaTiles and adds no `layers=` to the url, while
`/` uses the default basemap as it should. (Recorded when that default was named
`Offline`; it is `NaturalEarth` now, and the behaviour is what was checked.)

For comparison, production before this change answered a missing data asset with
`200 text/html`.

**One inconsistency worth knowing:** with the service worker installed, a navigation to an
unknown route is answered from precache by `navigateFallback`, so it shows the app rather
than the 404 page. The server and the service worker disagree there, deliberately — offline
that is the behaviour you want.

## Layers: the base map's depth upgrade

**Procedure.** Open a checkout where `data/imagery/NaturalEarthII/3/` is absent — one where
nobody has run `pnpm update-imagery`, which any fresh clone is — and load the default route.
Read the basemap selection, the url, and the console, then zoom in past continent scale. Then
run the generator, reload, and zoom in again. Do **not** simulate the absent case by deleting
files from a running dev server: see below.

**Result, 2026-08-04, Chrome, dev and built preview.** Basemap `NaturalEarth` in both cases,
url untouched, console clean, and a correct globe either way — `maximumLevel` 2 without the
generated levels and 5 with them. Nothing about the selection changes; only the ceiling does.
The ceiling is a build-time `define`, so the restart after running the generator is expected.

**Above the ceiling the map is complete, not holed.** Checked directly by building with levels
4–5 removed while the ceiling stayed at 5, so Cesium requested tiles that did not exist: the
Alps and Italy rendered in full from magnified level-3 imagery, with visible rectangular seams
where neighbouring terrain tiles magnify by different amounts. That is `TileImagery` walking up
to the closest ready ancestor, and it is the same path taken offline in a region the runtime
cache has never held — which is why the precache goes to level 3 rather than 2.

One measurement worth keeping from the attempt that failed: in the built preview a ranged
request for a missing tile returns **206 with `content-type: text/html`**, the SPA fallback
honouring the Range header. `response.ok` is true. Any probe that trusted status alone would
have reported the deep levels present.

**What this replaced, and why it is worth remembering.** The old arrangement asked whether the
imagery was _missing_ and, if so, rewrote the layer selection to a second `Offline` provider
backed by Cesium's own differently-graded tiles — so the failure was visible as a colour shift,
a changed url and a warning. Two bugs came out of that shape: a probe answering after the
route's preset had hydrated clobbered the preset's chosen basemap, and

**the result recorded here for 2026-07-28 was simply wrong.** It reported the fallback firing,
but the probe tested only `response.ok`, and in a real unpopulated checkout the request for the
missing manifest was answered by the SPA fallback with **200 and `index.html`** — measured,
`content-type: text/html`, 1065 bytes of markup. The probe concluded the imagery was present
and the globe stayed blank, which is what was being reported from worktrees all along. That is
why every probe in this app checks what came back and not just its status, and why the levels
the globe cannot do without are committed rather than probed for at all.

Deleting the file from a running dev server most likely produced a 404 instead — the
static-copy middleware owns that path and fails outright, where a file that never existed
falls through to the SPA fallback. That is inference, not measurement, but it is reason
enough that this check must be run on a genuinely unpopulated checkout rather than a
simulated one.

## PWA: a data url in the address bar must not serve the app shell

**Why it is here.** The two halves are checkable separately but the whole needs a
deployed Worker plus an installed service worker, which no local setup reproduces: served
by `pnpm preview` there is no `/api` backend, so a denied navigation and a served shell
look identical.

**What was checked, 2026-07-30.** `https://satvis.space/api/groups.json` answers
`content-type: application/json` with the real index, with or without an HTML `Accept`
header — so the server was never the problem; the app shell came from the service worker.
`workbox-routing/NavigationRoute._match` rejects any request whose `mode !== "navigate"`
before consulting the denylist, and then tests `pathname + search`, which is why `.json`
missing from the extension list was enough to hand `/api/groups.json` to
`createHandlerBoundToURL("/index.html")`. The built `dist/sw.js` now carries
`denylist:[/\.(css|js|...)$/,/^\/api\//,/^\/data\//,/^\/cesium\//]`.

**Not checked:** a live navigation against a deployed Worker with the new service worker
installed. Worth doing after the next deploy — open the url in a tab and confirm JSON.

## Map menu: the Basemap/Overlays split, and Re:Earth terrain

**Procedure.** Open `?layers=ArcGis_0.5,Nextrad&terrain=ReEarth`, read the two imagery
groups, switch basemap, toggle an overlay, and fly somewhere with relief.

**Result, 2026-07-30, Chrome.** Basemap radios listed `Offline`, `OfflineHighres`,
`ArcGis`, `OSM`, `BlackMarble` with **ArcGis checked**[^basemaps] — bound by provider, so the `_0.5`
token still reads as the layer it is, which the old flat checkbox list did not. Overlays
listed `Tiles`, `GOES-IR`, `Nextrad` with Nextrad checked. Switching to OSM rewrote
`?layers=OSM,Nextrad`, keeping the overlay and dropping the old basemap's opacity, which
belonged to a layer no longer in the stack. Toggling `Tiles` gave `OSM,Nextrad,Tiles` and
three imagery layers, and untoggling gave back two.

Re:Earth terrain resolved `https://terrain.reearth.land/cesium-mesh/ellipsoid/` and
rendered the Bernese Alps with correct relief. Its required credit — "Re:Earth Terrain ·
Mapterhorn (CC BY 4.0)" — appears in the "Data attribution" display, alongside the
service's own layer.json credits (Mapterhorn, EGM2008, Protomaps, OpenStreetMap).

VersaTiles rendered the whole globe the right way up (no `{reverseY}` needed, since its
TileJSON declares no `scheme`) and resolved to sharp orthophoto over central Munich, with
tile requests observed from level 7 to 14 and no errors. "VersaTiles sources" is in the
attribution display. **Note for whoever runs this next:** an unfocused browser tab
throttles `requestAnimationFrame` to a standstill, so Cesium stops refining and the globe
sits on whatever coarse level it had — which looks exactly like broken imagery. Front the
tab, or drive `cc.viewer.scene.render()` in a loop, before concluding a provider is at
fault.

Worth re-running if the terrain looks flat: this is a free, keyless service on
best-effort uptime with no SLA, so it is the one terrain that can simply stop answering.

## Sky view: enabling a surface model must not lurch or flip

**Why it cannot be a unit test.** The symptom is a sequence of camera positions across
frames while terrain streams, which needs a live globe and a real network.

**Procedure.** Enter the sky view with `?scene=Sky&gs=48.1372,11.5756,Munich` and no
surface model, then enable OsmBuildings while recording `camera.position` and `camera.up`
on every `preRender`.

**Result, 2026-07-30, Chrome.** Two distinct eye heights, 2 m then 572.8 m — one
transition, in the same frame the terrain provider becomes World Terrain — and `up.z`
constant at 0.979 throughout, i.e. no orientation change. 572.8 m is CWT's Munich ground of
570.8 m plus the 2 m eye height.

Before the fix the same trace showed the eye stuck at 2 m while the provider had already
become World Terrain, leaving the camera ~570 m under the new ground (the reported flip:
inside terrain you see its underside), followed by a step per terrain refinement as
`getHeight` improved its answer — including one reading of -76639, which the plausibility
guard rejected.

## Sky view: moving the observer must not drop the eye underground

**Why it cannot be a unit test.** The symptom is a camera position across frames while an
asynchronous height measurement is in flight.

**Procedure.** Settle the sky view over Munich with OsmBuildings, then move the observer —
`cc.skyView.enter({ lat, lon })`, which is exactly what a station drag or an arriving
geolocation fix does — recording `camera.position` every `preRender`.

**Result, 2026-07-30, Chrome.** One height throughout, 572.8 m, `up.z` constant at 0.979.
Before the fix the move reset the ground height to sea level, putting the eye at 2 m while
Munich's ground is 570 m — 568 m underground for as long as the measurement took.

Worth knowing what that looks like, because it does not look like a wrong height: from
under a surface you see its underside wearing the same imagery, so the frame fills with
what reads as a plan view of the city, a horizon-like edge where the mesh ends, and black
below. It was reported as the world flipping. Reproduce it deliberately with
`cc.skyView.setGroundHeight(0)` over any city.

## Surface models: the matrix, the eye height, and what drapes on a mesh

The pure part is unit-tested (`src/config/surfaceModels.test.ts`); what needs a browser
is whether the scene agrees with it. Needs an unrestricted `VITE_CESIUM_ION_TOKEN`.

**Procedure.** With `?layers=ArcGis&gs=48.1372,11.5756,Munich`, walk `surface=` and
`scene=` through the combinations, reading `cc.surface.active`,
`scene.globe.show`, `scene.terrainProvider.constructor.name`, the camera's cartographic
height, and the dimmed groups in the Map panel.

**Result, 2026-07-29, Chrome.**

- `surface=OsmBuildings&scene=3D`: buildings drawn on the globe over Munich, terrain
  `CesiumTerrainProvider` while the store still holds `None`, Terrain group dimmed and
  Layers not. The Terrain radio reads `CesiumWorldTerrain` — the terrain in force, not the
  stored choice — its rows are disabled, and the note names what returns
  ("OsmBuildings needs CesiumWorldTerrain, None returns"). Re-checked 2026-07-30 after
  the radio was rebound; before that it read `None` and said nothing, which is what the
  rebinding fixed.
- `surface=GooglePhotorealistic&scene=Sky`: globe hidden, mesh drawn, both Layers and
  Terrain dimmed. The camera settled at **563.3 m** ellipsoid height at the observer —
  the mesh surface plus the 2 m eye height, where without the clamp it would have been
  2 m, i.e. some 560 m underground.
- Switching that to `scene=3D`: tileset removed, globe back, nothing dimmed, terrain
  back to `EllipsoidTerrainProvider`, `?surface=GooglePhotorealistic` still in the url,
  and the panel reads "Applies in the sky view only".
- `surface=OsmBuildings&scene=2D`: no tileset, terrain not overridden, panel reads
  "Applies in the 3D and sky views only".
- **Ground-clamped overlays under a hidden globe**: a probe corridor with
  `heightReference: CLAMP_TO_GROUND` through the observer rendered and draped onto the
  photorealistic mesh, following the street and correctly occluded by the buildings
  either side. So the Ground track component needs no suppression there.
- **Failure path**: with `VITE_CESIUM_ION_TOKEN=not-a-real-token`, selecting
  `GooglePhotorealistic` toasted "GooglePhotorealistic unavailable … Cesium ion needs a
  token valid for this origin", put the radio back to `None`, and dropped `surface`
  from the url. `SurfaceModel.apply` was called exactly twice — the attempt and the
  revert — so the failure is reported once.
- **Ground station pin**: at the Eiger with `terrain=CesiumWorldTerrain` the pin sits on
  the ridge, where at its stored height of 0 it had been ~4 km below the surface.

**Loading cost, 2026-07-30, Chrome.** Measured because "load the buildings later" turned
out to have nothing to defer: at globe altitude OSM Buildings loads _nothing_ — 0 tiles
visited, 0 ready, 0 MB — so Cesium already withholds it until the camera is near the
ground. In the sky view at Marienplatz, settled, the neighbourhood costs 34.38 MB across 34
tiles with the sky-view roll-off, against 39.73 MB across 40 tiles at Cesium's defaults:
a 13% saving from capping the radius at ~800 m. The eye sat at 573 m, i.e. ground + 2 m.

The globe's 2 km ceiling, same city, three altitudes: at 9,261 km and at 2,500 m the
tileset was hidden with 0 tiles visited and 0 MB; dropping to 1,400 m showed it and
streamed 35 tiles for 44 MB. Entering the sky view from there kept it shown with the
ground-level roll-off (density 8.0e-4, factor 48) and the eye at 573 m. Note the ceiling
is re-evaluated on `preRender`, so a camera moved from the console in a stalled render loop
will read as stuck hidden — force a frame before believing it.

**The mesh waits for the descent, 2026-07-30, Chrome.** Entering the sky view with
`surface=GooglePhotorealistic` from the default globe view: mid-flight the tileset was
present but `show: false` with **0 MB** of geometry and the globe still visible, so the
descent costs nothing and is not black. On landing, `settled: true` flipped it to
`show: true`, hid the globe, and started requests. The tileset carried
`maximumScreenSpaceError: 24`, `skipLevelOfDetail: true` and
`immediatelyLoadDesiredLevelOfDetail: true`.

The skip-LOD saving itself is **not measured** — a clean before-and-after needs an uncached
city and burns Google quota — so it is reasoned from Cesium's documented behaviour only.

The service-worker rule was checked in the build output rather than at runtime: `dist/sw.js`
contains `ion-asset-cache` and the pattern `ion\.cesium\.com`, and `googleapis` appears
zero times in it, which is the property that matters — Google's tiles must not be cached.

The 1 km OSM ceiling's above-ground behaviour is **unverified here**: this environment
never refines terrain past level 0, so `globe.getHeight` returns either nothing or
implausible values (-76594 was observed) and the sticky-last-believable fallback keeps the
gate on ellipsoid height. Worth re-checking in a real browser over a high city.

Not exercised: iOS, where the photorealistic mesh's tuned-down `cacheBytes` and
`maximumScreenSpaceError` apply, and where a phone's memory is the thing being protected.

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

[^basemaps]:
    `Offline` and `OfflineHighres` have since collapsed into the single `NaturalEarth`
    layer, so that list is one shorter now. What was being checked — that the radios bind
    by provider, so an `_0.5` token still reads as the layer it is — is unaffected.

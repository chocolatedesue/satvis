---
status: accepted
---

# Surface models are one selection with two shapes

The sky view stands on the ground and looks up. What is missing there is the ground
itself: the buildings around you are what tells you where you are standing, and what a
satellite low in the sky is actually behind. So the Map menu gains a third group beside
Layers and Terrain — `None`, `OsmBuildings`, `GooglePhotorealistic`, at most one, none by
default.

The name is **surface model**, not "buildings", because only one of the two is buildings.
Cesium OSM Buildings is extruded footprints and nothing else. Google Photorealistic 3D
Tiles is a photogrammetry mesh of ground, vegetation and buildings together — it does not
sit on the globe, it _replaces_ the part of it you can see.

That asymmetry is most of this design.

## Decision

### Picking Google hides the globe, and suppresses rather than overwrites

Cesium's own guidance is `globe.show = false` with the photorealistic mesh; leaving the
globe up means the ellipsoid and its imagery z-fighting the mesh, and terrain spiking
through rooftops. Hiding it makes two other Map-menu groups describe nothing.

Those selections are **suppressed, not rewritten** — the same trade `suppressCameraMode`
makes for `?camera=Inertial` and `suppressComponent("Orbit")` makes across a morph. The
store and the URL keep what the user chose, deselecting gives back exactly what was there,
and no history entry is pushed for a change nobody asked for. The menu dims the inert
groups instead, so it never claims to describe a picture it is not describing.

The terrain provider is deliberately left assigned while the globe is hidden, which looks
like an omission and is not: a hidden globe short-circuits `Globe.update`, `beginFrame`,
`render` and `endFrame`, so not one terrain tile is selected, requested or drawn. There is
nothing left to switch off, and dropping the provider would only cost a re-fetch on the way
back.

### OSM Buildings forces Cesium World Terrain

Its heights assume that terrain, and Cesium has no ground-clamping for tilesets. Paired
with anything else the buildings float or sink by the difference — metres in flat country,
far more in the mountains, and worst of all directly under a sky-view observer. So
selecting it imposes `CesiumWorldTerrain` for as long as it is up, through the same
suppression path. World Terrain is also offered as an ordinary terrain option, which is
what makes the imposition legible rather than mysterious.

### Where each model applies is data, and one of the two rules is about money

Neither model applies in 2D or Columbus. Cesium does not refuse a tileset there —
`Cesium3DTile` carries a 2D screen-space-error branch — so this is a choice: paying full
tile bandwidth for geometry that reads as broken is worse than drawing nothing.

`GooglePhotorealistic` is the **sky view only**, and that is a cost decision rather than a
technical one. It bills through Google's Map Tiles API per request against our ion account,
and satvis.space is public with the token committed. From a fixed viewpoint looking up,
tile loading is bounded by where the observer stands; on the globe it is bounded only by how
far someone cares to fly. OSM Buildings is a standard ion asset serving small tiles, so it
applies in 3D as well.

Both rules live as `viewModes` on the registry entry, so widening either is one line — which
is the point: this can be relaxed once real usage is known.

### The sky view needed a new source for the ground under it

`SkyView` read `globe.getHeight` every frame, which is free and correct while the globe is
being drawn. With the globe hidden the honest answer becomes `undefined`, and the fallback
left the eye at ellipsoid height — some 560 m _inside_ the mesh in Munich, looking at the
underside of the ground, a view that never recovers on its own.

So `SkyView` takes an optional `GroundHeightSource`, asked once per observer rather than
per frame, and the surface model answers it with `clampToHeightMostDetailed`. Two
consequences worth stating:

- It clamps to the **top** of whatever is there, so standing where a building stands puts
  the eye on its roof. That is also the only outcome that never buries the view, which is
  why it was preferred to sampling the ground beneath.
- The plausibility guard that existed for `getHeight` now earns its keep twice: the clamp
  answers against any scene geometry above the point, and a satellite's own 3D model
  passing overhead is scene geometry.

### The matrix is Cesium-free and tested

Everything above is one pure function, `surfaceEffects(surfaceModel, viewMode)`, in
`src/config/surfaceModels.ts`. The menu's dimming and the scene's contents are derived from
the same call, so a rule cannot hold in the renderer and quietly not in the UI.
`src/modules/SurfaceModel.ts` is then a thin executor: create, add, hide, measure, destroy.

### An ion token is committed

`src/config/ion.ts` carries a token restricted at ion to satvis.space, so production works
from a clean checkout and the token is useless to anyone who lifts it out of the repository
— the same trade the MapTiler key beside it already makes. `.env.production` could not
serve this purpose: it is gitignored, so a CI build would silently ship no token at all.

That restriction is also why `VITE_CESIUM_ION_TOKEN` exists: ion rejects the committed
token on localhost, on `deploy:preview` origins, and in iframes on foreign domains. It is
set globally as `Ion.defaultAccessToken` because `createGooglePhotorealistic3DTileset`
resolves its ion asset through `IonResource.fromAssetId` internally, with no way in for a
token of ours.

### A failure reverts the selection

Unlike the offline-imagery fallback there is no equivalent asset to swap in, so a tileset
that fails to create puts the selection back to `None` and says why in a toast. The
commonest cause is a token this origin is not allowed to use, and nothing else in the UI
would explain that. Per-tile failures only warn: one 403 tile is not grounds for tearing
the whole surface down.

## Consequences

- **The photorealistic mesh is tuned down from Cesium's defaults** — 1.5 GB of tile cache
  plus a 1 GB overflow is sized for a desktop flying the globe, not a phone standing still.
  It also runs with `dynamicScreenSpaceError`, which Cesium recommends for photogrammetry,
  and `showCreditsOnScreen: true`, following Google's Map Tiles policies rather than
  Cesium's reading of them. `enableCollision` stays at Cesium's default `true`: with the
  globe hidden, the mesh is the only thing stopping the camera dropping through the ground.
- **Ground-clamped overlays still work under the mesh.** Verified rather than assumed: the
  ground-track corridor's `classificationType` defaults to `BOTH`, and with no globe depth
  to classify against it drapes onto the tileset instead — running down the street and
  correctly occluded by the buildings either side. Where the mesh has no coverage there is
  nothing to drape on, but there is no globe there either.
- **A ground-station pin was buried and now is not.** Stations are placed at height 0, so
  the pin sat below any real surface. It was already wrong under terrain; the mesh made it
  obvious. Now clamped.
- **Every visitor can spend our ion quota**, bounded by the sky-view restriction and
  observable through a PostHog event on load. If that proves too generous the restriction
  tightens in `surfaceModels.ts`; if it proves cheap, 3D opens up the same way.
- **`?surface=` is carried even where it cannot apply**, so a model can be armed before
  entering the sky view and `?surface=GooglePhotorealistic&scene=Sky` is a working link.
  The menu annotates the selected-but-inactive case rather than disabling the control.

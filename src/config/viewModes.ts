// Where the viewer looks at the world from, and what the camera is fixed to.
// Kept here, free of Cesium, so the url schema and CesiumController share one
// list instead of restating it — the same reason src/config/components.ts
// exists.
//
// SCENE_MODES is the app's own view vocabulary, not Cesium's. The first three
// name a Cesium `SceneMode`; "Sky" does not — it is the ground-level sky view,
// which renders in 3D, so in that mode the store and `viewer.scene.mode`
// deliberately disagree. Nothing reads the store string to answer a Cesium
// question: every SCENE3D test goes to Cesium's own enum.
// See docs/adr/0003-sky-view.md.
//
// No `SceneMode` type alias on purpose: @cesium/engine exports an enum of that
// name, used in three files here, and a second one would be an import trap.

export const SCENE_MODES = ["3D", "2D", "Columbus", "Sky"] as const;
export const CAMERA_MODES = ["Fixed", "Inertial"] as const;

/** The one scene mode that is not a Cesium projection. */
export const SKY_MODE = "Sky";

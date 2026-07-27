// How the globe is projected and what the camera is fixed to. Kept here, free
// of Cesium, so the url schema and CesiumController share one list instead of
// restating it — the same reason src/config/components.ts exists.
//
// No `SceneMode` type alias on purpose: @cesium/engine exports an enum of that
// name, used in three files here, and a second one would be an import trap.

export const SCENE_MODES = ["3D", "2D", "Columbus"] as const;
export const CAMERA_MODES = ["Fixed", "Inertial"] as const;

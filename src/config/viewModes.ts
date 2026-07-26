// How the globe is projected and what the camera is fixed to. Kept here, free
// of Cesium, so the url schema and CesiumController share one list instead of
// restating it — the same reason src/config/components.ts exists.

export const SCENE_MODES = ["3D", "2D", "Columbus"] as const;
export const CAMERA_MODES = ["Fixed", "Inertial"] as const;

export type SceneMode = (typeof SCENE_MODES)[number];
export type CameraMode = (typeof CAMERA_MODES)[number];

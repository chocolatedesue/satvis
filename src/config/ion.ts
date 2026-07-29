// The Cesium ion access token, for the assets that need one: Cesium World
// Terrain and both surface models (src/modules/CesiumLayerProviders.ts).
//
// Committed on purpose. The default token is restricted at ion to satvis.space,
// so it is useless to anyone who lifts it out of this repository — the same
// trade the MapTiler key beside it already makes. That restriction is also why
// it is rejected on localhost and on `deploy:preview` origins: set
// VITE_CESIUM_ION_TOKEN in .env.development (gitignored) to an unrestricted
// token to develop against ion. Without one, ion assets fail to load, which the
// surface model reports as a toast rather than a blank scene.
//
// Set once as `Ion.defaultAccessToken` (src/app.ts) rather than passed per
// asset: `createGooglePhotorealistic3DTileset` resolves its ion asset through
// `IonResource.fromAssetId` internally, with no way in for a token of ours.
const SATVIS_SPACE_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI3ZmFkM2NiZC04NGJlLTRlOTYtOWNkYi1mZDA0ZjQwNWFjNDIiLCJpZCI6MjgzLCJzdWIiOiJGbG93bSIsImlzcyI6Imh0dHBzOi8vYXBpLmNlc2l1bS5jb20iLCJhdWQiOiJzYXR2aXMuc3BhY2UiLCJpYXQiOjE3ODUyODU4NTF9.L7ogGw5aWyv4jFApMbLVRiuPZrTIAQ5lE-cr4bC2sNc";

export const ionAccessToken: string = import.meta.env.VITE_CESIUM_ION_TOKEN || SATVIS_SPACE_TOKEN;

// The one module that names a DOM container and asks for a WebGL context.
//
// Split out of CesiumController's constructor, which used to do this itself
// against a hardcoded element id. Nothing else in the app constructs a Viewer,
// so this is the only file that cannot run outside a browser — and everything
// downstream of it takes the viewer as an argument instead of making one.

import { Viewer } from "@cesium/widgets";

/**
 * A viewer with this app's widget selection and scene defaults already applied.
 *
 * `minimalUI` is the caller's answer, not this module's: the same fact decides
 * which widgets exist here and how CesiumController treats the chrome later, and
 * it is read once (`DeviceDetect.minimalUI`) rather than re-derived per consumer.
 */
export function createViewer(container: string | Element, options: { minimalUI: boolean }): Viewer {
  const { minimalUI } = options;

  const viewer = new Viewer(container, {
    animation: !minimalUI,
    // No base layer here: the store's layer stack is the only default, and it
    // arrives through sceneSync's immediate watcher a tick later. Naming one
    // here as well meant two defaults that could drift, and it created the
    // layer without the availability probe that watcher applies.
    baseLayer: false,
    baseLayerPicker: false,
    fullscreenButton: !minimalUI,
    fullscreenElement: document.body,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    navigationInstructionsInitiallyVisible: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: !minimalUI,
    vrButton: !minimalUI,
    contextOptions: {
      webgl: {
        alpha: true,
      },
    },
  });

  // Cesium default settings
  viewer.clock.shouldAnimate = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.highDynamicRange = true;
  viewer.scene.maximumRenderTimeChange = 1 / 30;
  viewer.scene.requestRenderMode = true;

  return viewer;
}

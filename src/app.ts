import { Ion } from "@cesium/engine";
import ui from "@nuxt/ui/vue-plugin";
import { createPinia } from "pinia";
import { createApp, markRaw } from "vue";

import App from "./App.vue";
import { controllerKey } from "./composables/useController";
import { usePWAUpdate } from "./composables/usePWAUpdate";
import { ionAccessToken } from "./config/ion";
import { getConfigPreset } from "./config/presets";
import { CesiumController } from "./modules/CesiumController";
import { createViewer } from "./modules/createViewer";
import { startSceneSync } from "./modules/sceneSync";
import { DeviceDetect } from "./modules/util/DeviceDetect";
import piniaUrlSync from "./modules/util/urlSync";
import { router, setupRouterGuards } from "./router";

declare global {
  interface Window {
    /**
     * A console handle for debugging, and nothing else: the app itself reaches
     * the controller through `provide`/`inject` (see composables/useController)
     * or an argument. Assigned here rather than by the controller's own
     * constructor, so constructing one has no global side effect.
     */
    cc?: CesiumController;
  }
}

// Register Service Worker with automatic reload on update
usePWAUpdate({ autoUpdate: true });

// Before the viewer: everything ion-backed resolves through this one token, and
// nothing here can pass it per asset. See src/config/ion.ts.
Ion.defaultAccessToken = ionAccessToken;

// The composition root. The viewer is built here and handed to the controller,
// which is handed to the Vue tree — so every edge into the globe is an argument
// somebody passed rather than a global somebody found.
const app = createApp(App);
const viewer = createViewer("cesiumContainer", { minimalUI: DeviceDetect.minimalUI() });
const cc = new CesiumController(viewer);
app.provide(controllerKey, cc);
window.cc = cc;

// Setup Pinia with customConfig from preset
const pinia = createPinia();
pinia.use(({ store }) => {
  store.router = markRaw(router);
  store.customConfig = markRaw(getConfigPreset().config);
});
pinia.use(piniaUrlSync);
app.use(pinia);

// Carry store state into the globe. Not a component: it has to outlive every
// panel, and it must not depend on component mount order.
startSceneSync(cc);

// Setup router guards to handle configuration changes on route changes
setupRouterGuards(router, cc);
app.use(router);

app.use(ui);

// Mount the app
app.mount("#app");

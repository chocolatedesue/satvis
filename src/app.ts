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
import { applyMigrationScene, applySunSyncScene, applyTwoOrbitScene, applyWalker25Scene, type ClockControl, isDemoName } from "./modules/demoScenes";
import { startSceneSync } from "./modules/sceneSync";
import { DeviceDetect } from "./modules/util/DeviceDetect";
import { representativeAlwaysSunlitAltitudeKm } from "./modules/util/sunSynchronous";
import piniaUrlSync, { whenHydrated } from "./modules/util/urlSync";
import { router, setupRouterGuards } from "./router";
import { useCesiumStore } from "./stores/cesium";
import { useSatStore } from "./stores/sat";

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

setupRouterGuards(router, cc);
app.use(router);

app.use(ui);

app.mount("#app");

// `?demo=` opens straight into a demo scene, clock and all — the one thing a plain
// shared link cannot carry, because the clock rate is live viewer state and not in
// the url (see docs/adr/0001). Read once from the url and applied here so no panel
// need be open; the store writes it makes then round-trip to the url the normal
// way, so the address bar ends up self-describing and the `?demo=` shorthand is
// gone on the next navigation.
{
  const requested = new URLSearchParams(window.location.search).get("demo");
  if (isDemoName(requested)) {
    // Created before the wait, because whenHydrated() only promises about stores
    // registered by the time it is called.
    const satStore = useSatStore();
    const cesiumStore = useCesiumStore();
    const clock: ClockControl = {
      setMultiplier: (value) => {
        cc.viewer.clockViewModel.multiplier = value;
      },
      play: () => {
        cc.viewer.clockViewModel.shouldAnimate = true;
      },
    };
    // After the url has been read, not before. Url-sync hydrates on
    // `router.isReady()` — a microtask after this file's top level — and hydration
    // applies the route's preset before reading the query. Applying the scene
    // first meant the default preset's own `enabledTags` (`["Weather"]`) landed on
    // top of the scene's walker tag, so `?demo=migration` opened with the weather
    // group active and placed the pipeline on geostationary weather satellites
    // instead of the two planes the demo is about. Everything the preset does not
    // name survived, which is why this read as a half-applied scene rather than as
    // no scene at all.
    void whenHydrated().then(() => {
      if (requested === "migration") {
        applyMigrationScene(satStore, cesiumStore, clock);
      } else if (requested === "walker25") {
        applyWalker25Scene(satStore, cesiumStore, clock);
      } else if (requested === "sso") {
        applySunSyncScene(satStore, cesiumStore, clock, representativeAlwaysSunlitAltitudeKm() ?? 1760);
      } else {
        applyTwoOrbitScene(satStore, cesiumStore, clock);
      }
      cc.viewer.scene.requestRender();
    });
  }
}

// The loading screen in index.html has served its purpose once the globe is up.
// Faded rather than cut, so the handover reads as the screen resolving; removed
// rather than left hidden, because it is a full-screen overlay and leaving it in
// the tree would leave a second <h1> in the rendered document. Anything that
// never runs this file keeps it.
//
// index.html holds no comments of its own, being served to every visitor exactly
// as written, so the two things about its markup that are not self-evident live
// here. #shell sits outside #app because `[v-cloak]` hides that until Vue mounts,
// and a loading state nobody sees is not one. Its link to /about is the only one
// in the raw html: Googlebot runs this bundle and finds the toolbar link instead,
// but a crawler that does not has nothing else pointing at that page.
const shell = document.getElementById("shell");
if (shell) {
  shell.classList.add("is-done");
  // On the transition rather than a bare timer, so the node goes exactly when the
  // fade ends — with a timer behind it because transitionend never fires when the
  // transition is off (prefers-reduced-motion) or the tab is in the background.
  shell.addEventListener("transitionend", () => shell.remove(), { once: true });
  setTimeout(() => shell.remove(), 1000);
}

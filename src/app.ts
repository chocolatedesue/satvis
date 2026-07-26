import ui from "@nuxt/ui/vue-plugin";
import { createPinia } from "pinia";
import { createApp, markRaw } from "vue";

import App from "./App.vue";
import { usePWAUpdate } from "./composables/usePWAUpdate";
import { getConfigPreset } from "./config/presets";
import { CesiumController } from "./modules/CesiumController";
import piniaUrlSync from "./modules/util/pinia-plugin-url-sync";
import { router, setupRouterGuards } from "./router";

declare module "vue" {
  interface ComponentCustomProperties {
    cc: CesiumController;
  }
}

// Register Service Worker with automatic reload on update
usePWAUpdate({ autoUpdate: true });

// Setup Vue app
const app = createApp(App);
const cc = new CesiumController();
app.config.globalProperties.cc = cc;

// Setup Pinia with customConfig from preset
const pinia = createPinia();
pinia.use(({ store }) => {
  store.router = markRaw(router);
  store.customConfig = markRaw(getConfigPreset().config);
});
pinia.use(piniaUrlSync);
app.use(pinia);

// Setup router guards to handle configuration changes on route changes
setupRouterGuards(router, cc);
app.use(router);

app.use(ui);

// Mount the app
app.mount("#app");

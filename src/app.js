import { library } from "@fortawesome/fontawesome-svg-core";
import { faGithub } from "@fortawesome/free-brands-svg-icons";
import { faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import Aura from "@primeuix/themes/aura";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import ToastService from "primevue/toastservice";
import Tooltip from "primevue/tooltip";
import { createApp, markRaw } from "vue";

import App from "./App.vue";
import { usePWAUpdate } from "./composables/usePWAUpdate";
import { getConfigPreset } from "./config/presets";
import { CesiumController } from "./modules/CesiumController";
import piniaUrlSync from "./modules/util/pinia-plugin-url-sync";
import { router, setupRouterGuards } from "./router";

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

app.use(PrimeVue, {
  theme: {
    preset: Aura,
  },
});

// Setup directives and components
app.directive("tooltip", Tooltip);
app.use(ToastService);
library.add(faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye, faGithub);
app.component("FontAwesomeIcon", FontAwesomeIcon);

// Mount the app
app.mount("#app");

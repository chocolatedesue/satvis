import { createRouter, createWebHistory, type Router } from "vue-router";

import Satvis from "../components/Satvis.vue";
import { usePostHog } from "../composables/usePostHog";
import { getConfigPreset, updateMetadata } from "../config/presets";
import type { CesiumController } from "../modules/CesiumController";

const base = document.location.pathname.match(".*/")?.[0] ?? "/";

export const router: Router = createRouter({
  history: createWebHistory(base),
  routes: [
    { path: "/", component: Satvis, name: "default" },
    { path: "/ot", component: Satvis, name: "ot" },
    // Legacy routes for backward compatibility
    { path: "/index.html", redirect: "/" },
    { path: "/ot.html", redirect: "/ot" },
    // Unknown paths (e.g. the retired /move route) render the default preset
    // rather than an empty router-view; getConfigPreset falls back to `default`.
    { path: "/:pathMatch(.*)*", component: Satvis, name: "fallback" },
  ],
});

/**
 * Router guard to handle configuration changes when navigating between routes
 * Note: Initial load is handled in main.js before mounting
 */
export function setupRouterGuards(routerInstance: Router, cc: CesiumController): void {
  routerInstance.beforeEach((to, from, next) => {
    console.log(`Navigating to ${to.path} from ${from.path}`);

    // Get the new configuration preset based on the target route
    const preset = getConfigPreset(to.path);

    // Update document title and meta description
    updateMetadata(preset);

    // Load new element sets via the satellite catalog
    cc.sats.loadElementSets(preset.elements);

    next();
  });
}

usePostHog();

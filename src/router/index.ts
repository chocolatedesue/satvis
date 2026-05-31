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
    { path: "/move", component: Satvis, name: "move" },
    { path: "/ot", component: Satvis, name: "ot" },
    // Legacy routes for backward compatibility
    { path: "/index.html", redirect: "/" },
    { path: "/move.html", redirect: "/move" },
    { path: "/ot.html", redirect: "/ot" },
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

    // Load new TLE data (with delay to allow cleanup to complete)
    cc.sats.addFromTleUrls(preset.tleData);

    next();
  });
}

usePostHog();

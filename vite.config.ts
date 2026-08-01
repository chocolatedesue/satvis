/// <reference types="node" />
/// <reference types="vitest/config" />

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type UserConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { viteStaticCopy } from "vite-plugin-static-copy";
import type { InlineConfig as VitestInlineConfig } from "vitest/node";

// vitest reads its config from the `test` key here (no separate vitest.config.ts).
// On vitest 3 + vite 8 the `/// <reference types="vitest/config" />` module
// augmentation doesn't reach vite's own UserConfig, so type the config through a
// const carrying the `test` field explicitly (excess-property checks skip a
// variable). Drop the const/type once vitest is on v4, where the augmentation
// applies and the object literal can be passed to defineConfig directly.
type ViteConfigWithTest = UserConfig & { test?: VitestInlineConfig };

const cesiumEngineSource = "node_modules/@cesium/engine";
const cesiumWidgetsSource = "node_modules/@cesium/widgets";
const cesiumBaseUrl = "cesium";

const buildDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
let buildSha = "dev";
try {
  buildSha = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // not a git checkout (e.g. tarball build)
}

const port = process.env.PORT ? Number(process.env.PORT) : undefined;

const config: ViteConfigWithTest = {
  base: "",
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        embedded: fileURLToPath(new URL("embedded.html", import.meta.url)),
        test: fileURLToPath(new URL("test.html", import.meta.url)),
      },
      output: {
        // Separate vendor chunks for better caching
        codeSplitting: {
          groups: [
            { name: "vue", test: /@vue|vue-router|pinia|@vueuse/, priority: 60 },
            { name: "ui", test: /@nuxt\/ui|reka-ui|tailwindcss|@tanstack/, priority: 50 },
            { name: "icons", test: /@iconify/, priority: 40 },
            { name: "cesium", test: /@?cesium/, priority: 30 },
            { name: "analytics", test: /posthog/, priority: 20 },
            { name: "vendor", test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
  },
  define: {
    // Define relative base path in cesium for loading assets
    CESIUM_BASE_URL: JSON.stringify("./cesium"),
    __BUILD_DATE__: JSON.stringify(buildDate),
    __BUILD_SHA__: JSON.stringify(buildSha),
  },
  plugins: [
    vue(),
    // Neutral gray palette (default `slate` is blue-tinted and clashes with the
    // app's pure-dark toolbar surfaces).
    ui({
      ui: { colors: { neutral: "neutral" } },
      icon: { clientBundle: { scan: true } },
    }),
    viteStaticCopy({
      targets: [
        // Copy Cesium Assets, Widgets, and Workers to a static directory
        { src: `${cesiumEngineSource}/Build/ThirdParty`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumEngineSource}/Build/Workers`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumEngineSource}/Source/Assets`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumWidgetsSource}/Source`, dest: `${cesiumBaseUrl}/Widgets`, rename: { stripBase: 4 } },
        // Copy data files (data/gp snapshot flows through here → dist/data/gp/...).
        // data/tle is excluded: the legacy TLE pipeline is gone, but the exclusion
        // stays so stale local files from an old checkout never ship.
        { src: ["data/**", "!data/custom/**", "!data/tle/**"], dest: "data", rename: { stripBase: 1 } },
        { src: ["data/custom/dist/**"], dest: "data", rename: { stripBase: 3 } },
      ],
    }),
    VitePWA({
      registerType: "prompt",
      manifest: {
        name: "Satellite Orbit Visualization",
        short_name: "SatVis",
        description: "Satellite Orbit Visualization with CesiumJS",
        start_url: "/",
        scope: "/",
        id: "satvis.space",
        orientation: "natural",
        display: "standalone",
        background_color: "#000000",
        theme_color: "#0B222D",
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5000000,
        globPatterns: ["**/*.{js,css,html,svg,png,ico}", "cesium/Assets/**/*.{jpg,png,xml,json}"],
        globIgnores: ["cesium/ThirdParty/**/*", "cesium/Widgets/**/*", "cesium/Workers/**/*", "cesium/Assets/Textures/maki/*", "**/*.map"],
        sourcemap: true,
        navigateFallback: "/index.html",
        // Matched against `pathname + search`, and only for requests whose mode is
        // `navigate` — Workbox's NavigationRoute rejects everything else before it
        // consults this list, so it has no bearing on what `fetch()` receives.
        //
        // The extension list alone let `/api/groups.json` be answered with the app
        // shell, because `.json` is not in it: opening an API url in the address bar
        // is a navigation, and the service worker was happily serving index.html for
        // it. The three prefixes are the paths that hold data rather than routes, so
        // navigating to one should reach the network and get the real thing.
        navigateFallbackDenylist: [/\.(css|js|png|svg|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|txt|glb)$/, /^\/api\//, /^\/data\//, /^\/cesium\//],
        runtimeCaching: [
          {
            urlPattern: /cesium\/(Assets|Widgets|Workers)\/.*\.(css|js|json|jpg)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "cesium-cache",
              expiration: {
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
            },
          },
          {
            urlPattern: /data\/cesium-assets\/imagery\/.*\.(jpg|png|xml)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "cesium-tile-cache",
              expiration: {
                maxEntries: 20000,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                purgeOnQuotaError: true,
              },
            },
          },
          {
            // GP element sets: worker mode (/api/gp/<group>.json, groups, metadata),
            // static-snapshot mode (data/gp/<group>.json), and the worker probe —
            // so offline keeps working in every deployment mode.
            urlPattern: /(\/api\/(gp\/[^/]+|groups|metadata)|data\/gp\/[^/]+)\.json$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "satellite-data-cache",
              expiration: {
                maxAgeSeconds: 48 * 60 * 60, // 2 days
                maxEntries: 50,
              },
            },
          },
          {
            // Cesium ion assets: OSM Buildings tiles and World Terrain. ion already
            // serves them `public, max-age=86400`, so the browser covers a day on its
            // own; this survives eviction and works offline, which is what makes a
            // second sky-view session over the same city cost nothing.
            //
            // Scoped to this host on purpose. Google's photorealistic tiles come from
            // tile.googleapis.com, and their Map Tiles policies restrict caching — so
            // the one rule that must never widen into a path or a file extension is
            // this one.
            urlPattern: /^https:\/\/assets\.ion\.cesium\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "ion-asset-cache",
              expiration: {
                maxEntries: 4000,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                purgeOnQuotaError: true,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /data\/models\/.*\.glb$/,
            handler: "CacheFirst",
            options: {
              cacheName: "satellite-model-cache",
              expiration: {
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                maxEntries: 50,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
      },
      pwaAssets: {
        htmlPreset: "2023",
        preset: {
          transparent: {
            sizes: [64, 192, 512],
            favicons: [[48, "favicon.ico"]],
          },
          maskable: {
            sizes: [512],
            padding: 0,
          },
          apple: {
            sizes: [180],
            padding: 0,
          },
        },
        image: "public/logo.svg",
      },
      devOptions: {
        // enabled: true,
        type: "module",
      },
    }),
  ],
  resolve: { tsconfigPaths: true },
  test: {
    // Modules under test are Cesium-free; run in the node environment.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  server: {
    port,
    strictPort: port !== undefined,
    proxy: {
      // Proxy /api to production by default so `pnpm dev` works out of the box.
      // Point at a local worker with SATVIS_API_PROXY=http://localhost:8080.
      "/api": {
        target: process.env.SATVIS_API_PROXY ?? "https://satvis.space",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    strictPort: port !== undefined,
  },
  worker: {
    format: "es",
  },
};

export default defineConfig(config);

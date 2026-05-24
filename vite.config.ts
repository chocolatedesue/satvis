import { execSync } from "child_process";
import path from "path";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { viteStaticCopy } from "vite-plugin-static-copy";

const cesiumEngineSource = "node_modules/@cesium/engine";
const cesiumWidgetsSource = "node_modules/@cesium/widgets";
const cesiumBaseUrl = "cesium";

const buildDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const buildSha = execSync("git rev-parse --short HEAD").toString().trim();

export default defineConfig({
  base: "",
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      input: {
        index: path.resolve(__dirname, "index.html"),
        embedded: path.resolve(__dirname, "embedded.html"),
        test: path.resolve(__dirname, "test.html"),
      },
      output: {
        // Separate vendor chunks for better caching
        codeSplitting: {
          groups: [
            { name: "vue", test: /@vue|vue-router|pinia|@vueuse/, priority: 60 },
            { name: "primevue", test: /primevue|@primeuix/, priority: 50 },
            { name: "icons", test: /@fortawesome/, priority: 40 },
            { name: "cesium", test: /@?cesium/, priority: 30 },
            { name: "analytics", test: /posthog/, priority: 20 },
            { name: "vendor", test: /node_modules/, priority: 10 },
            { name: "app", test: /src/, priority: 1 },
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
    viteStaticCopy({
      targets: [
        // Copy Cesium Assets, Widgets, and Workers to a static directory
        { src: `${cesiumEngineSource}/Build/ThirdParty`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumEngineSource}/Build/Workers`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumEngineSource}/Source/Assets`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumWidgetsSource}/Source`, dest: `${cesiumBaseUrl}/Widgets`, rename: { stripBase: 4 } },
        // Copy data files
        { src: ["data/**", "!data/custom/**"], dest: "data", rename: { stripBase: 1 } },
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
        navigateFallbackDenylist: [/\.(css|js|png|svg|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|txt|glb)$/],
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
            urlPattern: /data\/tle\/.*\.txt$/,
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
  worker: {
    format: "es",
  },
});

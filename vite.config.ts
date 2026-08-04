/// <reference types="node" />
/// <reference types="vitest/config" />

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { viteStaticCopy } from "vite-plugin-static-copy";

// vitest reads its config from the `test` key here (no separate vitest.config.ts).

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

/**
 * Headers required for `performance.measureUserAgentSpecificMemory()` for the benchmark
 * panel's accurate memory footprint. See "Cross-origin isolation" in src/modules/benchmark/README.md.
 */
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

/** So the black globe does not have to be deduced. Reads the headers rather than restating them. */
const isolationNotice = {
  name: "satvis-isolation-notice",
  configurePreviewServer() {
    console.log(
      `\n  ${Object.keys(CROSS_ORIGIN_ISOLATION_HEADERS).join(" + ")} are set (accurate memory footprint is available).\n` +
        "  If the globe is black and the satellites are not, a service worker cached\n" +
        "  Cesium's workers before isolation existed: clear this origin's service worker\n" +
        "  and caches once.\n",
    );
  },
};

/**
 * How deep the base map goes — the canonical home for this decision.
 *
 * A build-time constant rather than a runtime probe, because whether levels 3-5 ship
 * is a fact about the build. Two things a probe got wrong, both measured: it requests
 * a file that is *expected* to be missing, which vite's static-copy middleware answers
 * with a thrown ENOENT and a full-screen overlay on a fresh clone's first `pnpm dev`;
 * and since `maximumLevel` stops Cesium requesting anything deeper, a probe failing
 * while offline stranded every level 4-5 tile already cached. The cost is that running
 * the generator mid-`pnpm dev` needs a restart.
 *
 * Level 3 is the marker rather than the manifest, which is committed and so always
 * present.
 */
const generatedImagery = existsSync(fileURLToPath(new URL("data/imagery/NaturalEarthII/3/0/0.webp", import.meta.url)));
const COMMITTED_MAX_LEVEL = 2;
const GENERATED_MAX_LEVEL = 5;

/**
 * Say so when the build is about to ship the base map capped at level 2.
 *
 * Levels 3-5 are generated rather than committed, so a build simply omits them when
 * nobody has run `pnpm update-imagery` — no error, a smaller precache, and a deployed
 * site whose globe goes soft the moment anyone zooms in. `pnpm deploy` runs
 * `pnpm build` directly, so forgetting the generator first is a one-command mistake
 * with no other symptom.
 *
 * A warning rather than a failure: CI legitimately has no generated levels, and the
 * app is designed to work without them. Making this fatal would break CI to catch a
 * deploy-time slip.
 */
const imageryNotice = {
  name: "satvis-imagery-notice",
  apply: "build" as const,
  buildStart() {
    if (generatedImagery) {
      return;
    }
    console.warn(
      "\n  data/imagery holds only the committed levels 0-2 — building without the\n" +
        "  generated ones. The base map will work, capped at level 2, and go soft as\n" +
        "  soon as anyone zooms in. Run `pnpm update-imagery` before deploying.\n",
    );
  },
};

export default defineConfig({
  base: "",
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        about: fileURLToPath(new URL("about.html", import.meta.url)),
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
    __IMAGERY_MAX_LEVEL__: JSON.stringify(generatedImagery ? GENERATED_MAX_LEVEL : COMMITTED_MAX_LEVEL),
  },
  plugins: [
    vue(),
    isolationNotice,
    imageryNotice,
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
        description:
          "Track 12,000+ satellites live on a 3D globe, or point your phone at the sky to spot them. Starlink, GPS, the ISS and more. Pass prediction, alerts, offline PWA.",
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
        globPatterns: [
          "**/*.{js,css,html,svg,png,ico}",
          "cesium/Assets/**/*.{jpg,png,xml,json}",
          // The offline base map, down to level 3 only — 170 tiles and 1.4 MB, against
          // 17.5 MB for the whole pyramid. Level 3 is a 4096x2048 world, which is about
          // what a full-globe viewport resolves (~1280 px across 360°), so this is the
          // depth at which the globe is guaranteed correct offline at any rotation
          // rather than only where someone happened to look. Levels 4 and 5 are zoomed-in
          // detail and stay with the CacheFirst rule below.
          //
          // Level 3 also sets the floor for everything below it. `maximumLevel` lets
          // Cesium ask for levels 4 and 5, and offline it will miss on any the runtime
          // cache has never held — at which point it magnifies the deepest tile it does
          // have. Precaching to 3 is what guarantees there is always one to magnify.
          //
          //
          // The manifest too: it carries the tiling scheme, and without it Cesium falls
          // back to WebMercator and `.png`, which is not this tileset in any respect.
          "data/imagery/NaturalEarthII/{0,1,2,3}/**/*.webp",
          "data/imagery/NaturalEarthII/tilemapresource.xml",
        ],
        globIgnores: [
          "cesium/ThirdParty/**/*",
          "cesium/Widgets/**/*",
          "cesium/Workers/**/*",
          "cesium/Assets/Textures/maki/*",
          // Cesium's own low-resolution Natural Earth II. Nothing requests it, so
          // precaching it spent 536 KB and 43 entries on imagery never fetched.
          "cesium/Assets/Textures/NaturalEarthII/**/*",
          "**/*.map",
          // The embed page's background, 3.8 MB of decoration on a page that is not
          // the app. The globs above do not match it today because it is a jpg, which
          // is exactly why it is listed: re-encoding it as png or webp later must not
          // silently add 3.8 MB to every visitor's install. Hence `bg.*`, not `bg.jpg`.
          "bg.*",
          // A social card, once there is one worth publishing, belongs here as
          // well: only a scraper unwrapping a shared link ever fetches it, and the
          // png glob above would otherwise precache it for every visitor.
          // The benchmarking framework (src/modules/benchmark), which
          // rolls up into the panel's chunk because the panel is its only
          // importer. The chunk is lazy, but the precache glob above would pull
          // it down for every visitor anyway — and only the Benchmark switch
          // ever loads it.
          "**/BenchmarkPanel-*.{js,css}",
        ],
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
            // Levels 0-3 are precached by the glob above and served from there; this
            // rule carries 4 and 5, which are 16 of the pyramid's 17.5 MB and only
            // wanted once someone zooms in.
            urlPattern: /data\/imagery\/.*\.(webp|jpg|png|xml)$/,
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
            // The optional generated star maps (src/config/starMaps.ts). Not
            // precached — the glob above covers `cesium/Assets`, where the
            // built-in sky box lives, so a first offline load has stars either
            // way. These are only fetched by someone who asked for them, and then
            // they should survive going offline.
            urlPattern: /data\/starmap\/.*\.webp$/,
            handler: "CacheFirst",
            options: {
              cacheName: "cesium-starmap-cache",
              expiration: {
                // Six faces each, for the 1K and 2K cuts.
                maxEntries: 12,
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
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
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
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
    // Same proxy as the dev server. `pnpm bench` measures a production build,
    // and a build with no satellite data to draw would measure nothing.
    proxy: {
      "/api": {
        target: process.env.SATVIS_API_PROXY ?? "https://satvis.space",
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: "es",
  },
});

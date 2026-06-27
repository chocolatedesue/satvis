# AGENTS.md

## Setup

```sh
git submodule update --init
pnpm install
```

A single `pnpm install` at the repository root installs dependencies for both
the SPA and the `worker/` package (a pnpm workspace). CI uses `pnpm ci`.

## Commands

| Task            | Command                                              |
| --------------- | ---------------------------------------------------- |
| Dev server      | `pnpm dev`                                           |
| Build           | `pnpm build`                                         |
| Lint (CI)       | `pnpm lint` (runs frontend and worker lint)          |
| Lint fix        | `pnpm lint:fix` (runs frontend and worker fixes)     |
| Type-check only | `pnpm type-check`                                    |
| Update TLE data | `pnpm update-tle` (fetches from CelesTrak/NORAD)     |
| Deploy          | `pnpm deploy` (builds frontend, then deploys worker) |

Worker-only scripts run via `pnpm --filter satvis-worker <script>`.

CI runs `lint` then `build` — no test suite exists.

## Architecture

- **Frontend**: Vue 3 + Vite + CesiumJS + PrimeVue. Single-page app in `src/`.
- **Worker**: Cloudflare Worker backend in `worker/` — a workspace package (`satvis-worker`) with its own `package.json`, installed by the root `pnpm install`. Uses Wrangler for dev/deploy. Has its own `lint`, `type-check`, and `generate-types` scripts (run via `pnpm --filter satvis-worker <script>`).
- **Data**: `data/` contains TLE files and Cesium assets (imagery, textures, stars). Copied into `dist/` at build time via `vite-plugin-static-copy`.
- Entrypoints: `index.html`, `embedded.html`, `test.html` (all configured as Vite MPA inputs).

## Key quirks

- **Cesium static assets**: Vite copies Cesium engine assets from `node_modules/@cesium/engine` and `@cesium/widgets` into `dist/cesium/`. The global `CESIUM_BASE_URL` is defined as `"./cesium"` in `vite.config.ts`.
- **Git submodules**: Required — `data/` content depends on them. Run `git submodule update --init` before first build.
- **Build globals**: `__BUILD_DATE__` and `__BUILD_SHA__` are injected via `vite.config.ts` `define`.
- **Path aliases**: `@/*` → `src/*`, `@components/*` → `src/components/*`, `@lib/*` → `src/lib/*` (in `tsconfig.json`).
- **Formatting**: `oxfmt` (config in `.oxfmtrc.json`): `printWidth: 180`, `sortImports`, and `sortPackageJson` enabled.
- **Linting**: `pnpm lint` runs frontend `oxlint`, `oxfmt --check`, and `vue-tsc`, then the worker's own lint script.
- **Env files**: `.env.development` / `.env.production` — only PostHog keys (`VITE_POSTHOG_*`). See `.env.example`.
- **PWA**: Service worker via `vite-plugin-pwa` with Workbox caching strategies.
- **TypeScript**: Strict mode, `noUnusedLocals`, `noUncheckedIndexedAccess`. Unused vars must be prefixed with `_`.
- **Vue conventions**: Component names in templates must use kebab-case.

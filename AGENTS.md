# AGENTS.md

## Setup

```sh
git submodule update --init
npm ci
npm --prefix worker ci
```

## Commands

| Task            | Command                                                 |
| --------------- | ------------------------------------------------------- |
| Dev server      | `npm run dev`                                           |
| Build           | `npm run build`                                         |
| Lint (CI)       | `npm run lint` (runs frontend and worker lint)          |
| Lint fix        | `npm run lint:fix` (runs frontend and worker fixes)     |
| Type-check only | `npm run type-check`                                    |
| Update TLE data | `npm run update-tle` (fetches from CelesTrak/NORAD)     |
| Deploy          | `npm run deploy` (builds frontend, then deploys worker) |

CI runs `lint` then `build` — no test suite exists.

## Architecture

- **Frontend**: Vue 3 + Vite + CesiumJS + PrimeVue. Single-page app in `src/`.
- **Worker**: Cloudflare Worker backend in `worker/` — separate `package.json`, independent `npm ci`. Uses Wrangler for dev/deploy. Has its own `lint`, `type-check`, and `generate-types` scripts (run from `worker/`).
- **Data**: `data/` contains TLE files and Cesium assets (imagery, textures, stars). Copied into `dist/` at build time via `vite-plugin-static-copy`.
- Entrypoints: `index.html`, `embedded.html`, `test.html` (all configured as Vite MPA inputs).

## Key quirks

- **Cesium static assets**: Vite copies Cesium engine assets from `node_modules/@cesium/engine` and `@cesium/widgets` into `dist/cesium/`. The global `CESIUM_BASE_URL` is defined as `"./cesium"` in `vite.config.ts`.
- **Git submodules**: Required — `data/` content depends on them. Run `git submodule update --init` before first build.
- **Build globals**: `__BUILD_DATE__` and `__BUILD_SHA__` are injected via `vite.config.ts` `define`.
- **Path aliases**: `@/*` → `src/*`, `@components/*` → `src/components/*`, `@lib/*` → `src/lib/*` (in `tsconfig.json`).
- **Formatting**: `oxfmt` (config in `.oxfmtrc.json`): `printWidth: 180`, `sortImports`, and `sortPackageJson` enabled.
- **Linting**: `npm run lint` runs frontend `oxlint`, `oxfmt --check`, and `vue-tsc`, then the worker's own lint script.
- **Env files**: `.env.development` / `.env.production` — only PostHog keys (`VITE_POSTHOG_*`). See `.env.example`.
- **PWA**: Service worker via `vite-plugin-pwa` with Workbox caching strategies.
- **TypeScript**: Strict mode, `noUnusedLocals`, `noUncheckedIndexedAccess`. Unused vars must be prefixed with `_`.
- **Vue conventions**: Component names in templates must use kebab-case.

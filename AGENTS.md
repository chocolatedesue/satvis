# AGENTS.md

## Setup

```sh
git submodule update --init
pnpm install
```

A single `pnpm install` at the repository root installs dependencies for both
the SPA and the `worker/` package (a pnpm workspace). CI uses `pnpm ci`.

## Commands

| Task              | Command                                                               |
| ----------------- | --------------------------------------------------------------------- |
| Dev server        | `pnpm dev` (proxies `/api` → <https://satvis.space>)                  |
| Full-stack dev    | `pnpm dev:worker` + `SATVIS_API_PROXY=http://localhost:8080 pnpm dev` |
| Build             | `pnpm build`                                                          |
| Test (CI)         | `pnpm test` (frontend) and `pnpm --filter satvis-worker test`         |
| Lint (CI)         | `pnpm lint` (runs frontend and worker lint)                           |
| Lint fix          | `pnpm lint:fix` (runs frontend and worker fixes)                      |
| Type-check only   | `pnpm type-check`                                                     |
| Refresh static GP | `pnpm update-gp` (writes the gitignored `data/gp/` snapshot)          |
| Deploy            | `pnpm deploy` (builds frontend, then deploys worker)                  |

Worker-only scripts run via `pnpm --filter satvis-worker <script>`.

CI runs `lint`, then `test` (frontend + worker), then `build`.

## Architecture

- **Frontend**: Vue 3 + Vite + CesiumJS + Nuxt UI (Tailwind). Single-page app in `src/`.
- **Worker**: Cloudflare Worker backend in `worker/` — a workspace package (`satvis-worker`) with its own `package.json`, installed by the root `pnpm install`. Uses Wrangler for dev/deploy. Has its own `lint`, `type-check`, `test`, and `generate-types` scripts (run via `pnpm --filter satvis-worker <script>`).
- **Satellite data (GP element sets)**: fetched from CelesTrak as OMM JSON.
  - The worker refreshes each group into Workers KV via a cron trigger (every 6 h) and serves `/api/gp/<group>.json` and `/api/groups.json`.
  - **`POST /api/refresh`** runs the same refresh on demand and needs `Authorization: Bearer <REFRESH_TOKEN>` (a Worker secret; unset ⇒ 503). CelesTrak firewalls by IP (250 MB/day, 50 HTTP errors per 2 h) and Cloudflare's egress IPs are shared across tenants, so an open trigger risks a block that stalls the cron. One run costs ~12 MB.
  - Config is declarative and YAML: core config in `worker/src/config/satvis.core.yaml`, plugin config in `data/custom/<plugin>/satvis.yaml`. Each contributes two independent sections — `groups` (`sources`/`satellites`/`select`/`rename`/`include`/`extraRecordsFile`) and `satellites` (static per-satellite facts keyed by NORAD id). `pnpm --filter satvis-worker generate-groups` merges them into the gitignored `worker/src/config/satvis.generated.json`.
  - **Satellite metadata** (swath extents, sensor FOV, model URL, operator) is attached to each matching record **at refresh time**, under a lowercase `metadata` key, from the merged satellite table. There is no metadata endpoint and no browser-side rule matching: a record either carries the bag or the frontend applies its defaults (`src/config/satelliteMetadata.ts`). See `docs/adr/0002-static-satellite-metadata.md`.
  - **Worker-less mode**: `pnpm update-gp` runs the same evaluator and writes a static snapshot into `data/gp/` (gitignored). The app probes `/api/groups.json` and falls back to that snapshot.
- **Data assets**: `data/` also contains Cesium assets (imagery, textures, stars) and 3D-model plugins under `data/custom/`. Copied into `dist/` at build time via `vite-plugin-static-copy`.
- Entrypoints: `index.html`, `embedded.html`, `test.html` (all configured as Vite MPA inputs).

## Key quirks

- **Cesium static assets**: Vite copies Cesium engine assets from `node_modules/@cesium/engine` and `@cesium/widgets` into `dist/cesium/`. The global `CESIUM_BASE_URL` is defined as `"./cesium"` in `vite.config.ts`.
- **Git submodules**: Required — `data/` content depends on them. Run `git submodule update --init` before first build. **`git worktree add` does not populate them**, so a fresh worktree has an empty `data/cesium-assets` (high-resolution offline imagery) and `data/models` (3D models). Imagery covers for this: the `OfflineHighres` layer probes its `tilemapresource.xml` and, when it is missing, the selection is switched to the bundled `Offline` layer with a toast. The probe exists because Cesium cannot report the failure — `TileMapServiceImageryProvider.fromUrl` treats a missing `tilemapresource.xml` as "carry on with defaults" and resolves happily, then 404s every tile behind a blank globe. The 3D models have no such fallback yet.
- **Build globals**: `__BUILD_DATE__` and `__BUILD_SHA__` are injected via `vite.config.ts` `define`.
- **Path aliases**: `@/*` → `src/*` (in `tsconfig.json`).
- **Formatting**: `oxfmt` (config in `.oxfmtrc.json`): `printWidth: 180`, `sortImports`, and `sortPackageJson` enabled.
- **Linting**: `pnpm lint` runs frontend `oxlint`, `oxfmt --check`, and `vue-tsc`, then the worker's own lint script.
- **Env files**: `.env.development` / `.env.production` — only PostHog keys (`VITE_POSTHOG_*`). See `.env.example`.
- **PWA**: Service worker via `vite-plugin-pwa` with Workbox caching strategies.
- **TypeScript**: Strict mode, `noUnusedLocals`, `noUncheckedIndexedAccess`. Unused vars must be prefixed with `_`.
- **Vue conventions**: Component names in templates must use kebab-case.

## Deployment

`pnpm deploy` builds the frontend and deploys the worker. The worker needs a KV
namespace bound as `GP_KV` (see `worker/wrangler.jsonc`). After the first
deploy, KV is empty until a cron run fills it — either wait for the cron
(≤ 6 h) or force a fill now against the deployed KV:

```
cd worker
wrangler dev --remote --test-scheduled
curl "http://localhost:8080/__scheduled?cron=23+*%2F6+*+*+*"
```

### Private plugin config (`data/custom/<plugin>/satvis.yaml`)

Private plugins are untracked directories under `data/custom/`, each holding a
declarative YAML config (same trust model as before — never commit private plugin
data). They replaced hand-written `sync.sh` scripts that `grep`/`sed`-ed the bundled
TLE files. A config has two independent top-level sections, both optional: `groups`
and `satellites`.

The generator **fails loudly** on a plugin directory holding a pre-YAML
`groups.json` with no `satvis.yaml` beside it — a silent skip would make that
plugin's groups vanish from the build.

`groups` entries take:

- **`satellites`** (preferred for known, individually-named satellites): an
  array of per-satellite rows, each co-locating a satellite's NORAD id, its
  expected upstream name, and its display name so a rename's three facts live
  together instead of being scattered across `select.noradIds` and `rename`:

  ```yaml
  satellites:
    - { noradId: 25544, upstreamName: ISS (ZARYA), name: ISS }
  ```

  A row matches by `noradId` when present (else by exact `upstreamName`), is
  unioned with `select`, and its `name` renames the matched record (taking
  precedence over the `rename` map). Omit `name` to keep the upstream name;
  omit `noradId` to select a satellite that only has an upstream name. When a
  row carries both id and `upstreamName`, an id match against a differently
  named record — or a row whose id matches nothing — surfaces a warning in
  `/api/groups.json` (the group's `warnings` array) so upstream renames and
  decays are caught.

  Optional per-row **`metadata`** (e.g. `{ swathStarboardKm: 205, swathPortKm: 205 }`)
  is lifted into the merged satellite table under that row's `noradId`, so it
  applies **wherever the record is served**, not only in this group — write a
  value once even when the satellite appears in several groups. Requires a
  `noradId` (matching is by id only) and must not be empty. Two places giving one
  satellite different values for a field is a build failure, not a precedence
  question.

  Optional **`decayed: true`** marks a satellite expected never to match again. It
  suppresses the "matched no record" warning (and warns in reverse if the id does
  match), so a permanently-gone satellite cannot bury the report of one that has
  just disappeared unexpectedly.

- **`select`** (for bulk/pattern selection): `noradIds`, `names`, or a
  `namePattern` regex, ORed together. Prefer `noradIds` over `names` — CelesTrak
  `OBJECT_NAME` values are matched exactly and lose the old fixed-width TLE
  padding, so name matches are brittle. Use `namePattern` for whole
  constellations (`^STARLINK`).
- **`rename`**: `{ "<OBJECT_NAME>": "<new name>" }`, applied after select to any
  record a `satellites` row did not already rename. Use for bulk/pattern renames;
  for a single known satellite prefer a `satellites` row.
- **`extraRecordsFile`**: a path (relative to the config) to a TLE text file for
  pseudo element sets (fake satnums that can't be expressed as OMM). The
  generator inlines it into `extraRecords`.
- **`include`**: compose groups by name. **Semantics differ from the old shell
  pipeline**: an included group contributes its FULL evaluated output —
  including its own `extraRecords` and renames — prepended before this group's
  records (the old sync.sh concatenated the base list _before_ appending
  extras). If you need the old ordering, split the extras into a separate
  included group. See the comment on `include` in `worker/src/gp/types.ts`.
- **`celestrakSup`**: use `{ celestrakSup: <file> }` sources for CelesTrak
  supplemental data (e.g. launch/pre-launch element sets).

The top-level **`satellites`** section (a sibling of `groups`, not nested inside
one) is the satellite table: static facts keyed by NORAD id, independent of any
group, because a satellite's swath is not a fact about a group. `name` there is
documentation only — matching is by id.

```yaml
satellites:
  - { noradId: 41335, name: SENTINEL-3A, swathStarboardKm: 1000, swathPortKm: 500 }
```

Everything in an entry except `noradId`, `name` and `decayed` **is** the metadata
bag, so adding a field is a data-only edit. Swath extents are per-side cross-track
distances from the ground track relative to flight direction (starboard = velocity
bearing + 90°) — not halves of a width, and required in both-or-neither pairs. Use
a group row's `metadata` when the row already exists; use this table otherwise —
and note that adding rows to a pass-all group (one with neither `satellites` nor
`select`) would filter it down to just those rows.

Deploy migration: write the plugin `satvis.yaml`, delete the old local `sync.sh`
and any pre-YAML `groups.json`, `pnpm deploy`, then force the first KV fill as
above.

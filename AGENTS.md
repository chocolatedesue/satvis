# AGENTS.md

## Setup

```sh
git submodule update --init
pnpm install
```

A single `pnpm install` at the repository root installs dependencies for both
the SPA and the `worker/` package (a pnpm workspace). CI uses `pnpm ci`.

## Commands

| Task               | Command                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| Dev server         | `pnpm dev` (proxies `/api` → <https://satvis.space>)                              |
| Full-stack dev     | `pnpm dev:worker` + `SATVIS_API_PROXY=http://localhost:8080 pnpm dev`             |
| Build              | `pnpm build`                                                                      |
| Test (CI)          | `pnpm test` (frontend) and `pnpm --filter satvis-worker test`                     |
| Lint (CI)          | `pnpm lint` (runs frontend and worker lint)                                       |
| Lint fix           | `pnpm lint:fix` (runs frontend and worker fixes)                                  |
| Type-check only    | `pnpm type-check`                                                                 |
| Refresh static GP  | `pnpm update-gp` (writes the gitignored `data/gp/` snapshot)                      |
| Push GP off-Worker | `SATVIS_REFRESH_TOKEN=… pnpm --filter satvis-worker push-gp` (see below)          |
| Build the base map | `pnpm update-imagery` (docker; adds the gitignored levels 3–5 to `data/imagery/`) |
| Build the star map | `pnpm update-starmap` (docker; writes the gitignored `data/starmap/` faces)       |
| Deploy             | `pnpm deploy` (builds frontend, then deploys worker)                              |

Worker-only scripts run via `pnpm --filter satvis-worker <script>`.

CI runs `lint`, then `test` (frontend + worker), then `build`.

## Architecture

- **Frontend**: Vue 3 + Vite + CesiumJS + Nuxt UI (Tailwind). Single-page app in `src/`.
- **Worker**: Cloudflare Worker backend in `worker/` — a workspace package (`satvis-worker`) with its own `package.json`, installed by the root `pnpm install`. Uses Wrangler for dev/deploy. Has its own `lint`, `type-check`, `test`, and `generate-types` scripts (run via `pnpm --filter satvis-worker <script>`).
- **Satellite data (GP element sets)**: fetched from CelesTrak as OMM JSON.
  - The worker refreshes each group into Workers KV via a cron trigger (every 6 h) and serves `/api/gp/<group>.json` and `/api/groups.json`.
  - **`POST /api/refresh`** runs the same refresh on demand and needs `Authorization: Bearer <REFRESH_TOKEN>` (a Worker secret; unset ⇒ 503). CelesTrak firewalls by IP (250 MB/day, 50 HTTP errors per 2 h) and Cloudflare's egress IPs are shared across tenants, so an open trigger risks a block that stalls the cron. One run costs ~7 MB (mostly the shared `active` download).
  - **`POST /api/ingest`** takes the same bearer token and runs the same refresh against payloads the caller already downloaded, instead of fetching them itself (`bundleFetch` swaps the `FetchImpl`; everything downstream is the cron's code path, validation included). It has no cooldown — that window protects CelesTrak's download budget, which an ingest does not spend. `worker/scripts/push-gp.mjs` (`pnpm --filter satvis-worker push-gp`) is the client: it runs the worker's own `fetchSources` from wherever you run it and POSTs the result. **Reach for this when every source reports `HTTP 522`** — that is CelesTrak firewalling Cloudflare's shared egress, not a Cloudflare fault (celestrak.org is not behind Cloudflare, so it cannot emit a 522 itself), and the cron cannot recover on its own.
  - Config is declarative and YAML: core config in `worker/src/config/satvis.core.yaml`, plugin config in `data/custom/<plugin>/satvis.yaml`. Each contributes two independent sections — `groups` (`sources`/`satellites`/`select`/`rename`/`include`/`extraRecordsFile`) and `satellites` (static per-satellite facts keyed by NORAD id). `pnpm --filter satvis-worker generate-groups` merges them into the gitignored `worker/src/config/satvis.generated.json`.
  - **Satellite metadata** (swath extents, sensor FOV, model URL, operator) is attached to each matching record **at refresh time**, under a lowercase `metadata` key, from the merged satellite table. There is no metadata endpoint and no browser-side rule matching: a record either carries the bag or the frontend applies its defaults (`src/config/satelliteMetadata.ts`). See `docs/adr/0002-static-satellite-metadata.md`.
  - **Worker-less mode**: `pnpm update-gp` runs the same evaluator and writes a static snapshot into `data/gp/` (gitignored). The app probes `/api/groups.json` and falls back to that snapshot.
- **Data assets**: `data/` also contains the generated Cesium assets (base map, star maps) and 3D-model plugins under `data/custom/`. Copied into `dist/` at build time via `vite-plugin-static-copy`.
  - **`data/imagery/`** holds the `NaturalEarth` base map — the default, and the only offline one: a geodetic TMS pyramid of Natural Earth II as 256px WebP. **Part tracked, part generated.** Levels 0–2 and `tilemapresource.xml` are committed (42 tiles, 0.35 MB); levels 3–5 are gitignored and come from `pnpm update-imagery` (17.2 MB more). So every checkout has a correct globe with no docker and no extra step, and the app has no absent-imagery case at all. The generator applies the colour grade the retired `Flowm/cesium-assets` tileset was cut with (`RECOLOR` in `scripts/imagery/tiles.py`), because the raw public source is 48 levels per channel brighter; a run finishes by checking itself against that old tileset when it is available, and agrees to ~3 levels, the lossy-encoding floor. Nothing in the app names the tile format — Cesium reads the extension out of the manifest, so the generator is the only place that decides it.
    - **Committing generated output is safe because the generator is reproducible.** Levels 0–2 come out byte-identical across repeated runs, `--processes 1` against 14, and arm64 against amd64 (all measured). Two things hold that: `SOURCE_SHA256` pins the upstream archive and a mismatch is fatal, and the depth is **not** adjustable — at depth 5 level 2 is an average of averages down from the base, at depth 2 it is tiled straight from the source, and the two disagree, so a `--zoom` flag would have silently rewritten tracked files.
    - **The manifest declares only levels 0–2, whatever was built.** That keeps the tracked copy byte-identical and makes it honest about what a generator-less checkout has. The depth actually used is `__IMAGERY_MAX_LEVEL__`, set in `vite.config.ts` from an `existsSync` on `3/0/0.webp` and passed as Cesium's `maximumLevel`, which overrides the manifest. **A build-time constant, not a probe** — whether those tiles ship is a fact about the build. A probe was written first and rejected for two reasons: it requests a file that is _expected_ to be missing, which vite's static-copy middleware answers with a thrown `ENOENT` and a full-screen error overlay on a fresh clone's first `pnpm dev`; and since `maximumLevel` stops Cesium _requesting_ anything deeper, a probe failing while offline would strand every level 4–5 tile already in the runtime cache. The cost is that running the generator mid-`pnpm dev` needs a restart.
    - **Nothing is left that rewrites the user's layer selection.** There is no absent-imagery case, so no swap, no url rewrite, no warning — which retires the race the old fallback had, where a probe answering after the route preset hydrated clobbered the preset's basemap.
    - **Levels 0–3 are precached, 4 and 5 are not** (170 tiles, 1.4 MB against 17.5 MB). Above the ceiling — and offline anywhere the runtime cache has never been — Cesium magnifies the deepest tile it holds rather than leaving a hole (`TileImagery` walks up to the closest ready ancestor, verified in a build with levels 4–5 removed: complete map, visible seams where neighbouring tiles magnify by different amounts). Precaching through level 3 is what guarantees such an ancestor always exists.
    - **A build with only the committed levels is a normal build.** `vite.config.ts` warns (`satvis-imagery-notice`) rather than failing, because CI legitimately has no generated levels — but `pnpm deploy` runs `pnpm build` directly, so that warning is the only thing between a forgotten `pnpm update-imagery` and a deploy capped at level 2.
  - **`data/starmap/`** holds the `DeepStar1K` and `DeepStar2K` sky box faces, built by `pnpm update-starmap`. Generated rather than checked out, and so gitignored — but unlike `data/gp/` the _directory_ is tracked, carrying a self-ignoring `.gitignore`, because the generator bind-mounts it and docker would otherwise create a missing mount point owned by root. Absent until someone runs it, which is why the star maps are probed for before the menu offers them (`src/config/starMaps.ts`). The generator itself lives under `scripts/`, not `data/`, precisely because the copy glob takes `data/**` wholesale — anything kept under `data/` ships.
- Entrypoints: `index.html`, `embedded.html`, `test.html` (all configured as Vite MPA inputs), plus `public/404.html`. `/ot` is **not** a file: `public/_redirects` rewrites it to `/` with a 200, so it serves the same shell at the same url rather than a near-copy that could drift.

## Key quirks

- **Cesium static assets**: Vite copies Cesium engine assets from `node_modules/@cesium/engine` and `@cesium/widgets` into `dist/cesium/`. The global `CESIUM_BASE_URL` is defined as `"./cesium"` in `vite.config.ts`.
- **Git submodules**: `data/models` (3D models) is now the only one; run `git submodule update --init` before first build. **`git worktree add` does not populate submodules**, so a fresh worktree has it empty, and the 3D models have no fallback for that yet.
  - **`data/cesium-assets` was removed.** It served the base map and the star maps; both are generated now. The two things that still wanted it were self-checks rather than inputs — the base map generator compares its tiles against the old tileset, the star map generator correlates its faces against the Tycho ones — and both read the reference only _after_ writing their output, so neither can change a byte of what is generated. Keeping a submodule everyone had to initialise for two checks most people never run was the wrong trade; `scripts/generate.sh` now mounts an optional clone at **`scripts/.reference/cesium-assets`** (gitignored, clone command in the script's note and in `scripts/.reference/.gitignore`) and skips with a message when it is absent.
  - **Probes must read the answer, not just its status** — and are better avoided. `pnpm dev` answers a file that never existed with `index.html` and a 200, the deployed Worker used to as well, and a ranged request for one gets a **206 with `content-type: text/html`** (measured), so `response.ok` alone reports success on exactly the checkouts a probe exists to detect. The old imagery probe passed for a year on the worktrees it was written for. `src/config/starMaps.ts` is the one that remains, and it checks the content type; it is also a ranged `GET` and never a `HEAD`, because the Cache API ignores non-GET requests, so a HEAD would miss the service worker's caches and misreport to anyone merely offline. Where the answer is knowable at build time, prefer a `define` — that is why the base map's depth is one.
- **Dev and preview are cross-origin isolated**: `vite.config.ts` sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on every `pnpm dev` and `pnpm preview` response. That is what exposes `performance.measureUserAgentSpecificMemory()` for the benchmark panel's accurate memory footprint; production does **not** send them. `credentialless` rather than `require-corp` because the globe's tile hosts send no CORP header. One symptom to recognise: an isolated document refuses to start a dedicated worker from a service-worker-cached response that has no COEP header, and the result is a **black globe with the satellites still drawing** — clear that origin's service worker. See "Cross-origin isolation" in `src/modules/benchmark/README.md`.
- **Build globals**: `__BUILD_DATE__` and `__BUILD_SHA__` are injected via `vite.config.ts` `define`.
- **Path aliases**: `@/*` → `src/*` (in `tsconfig.json`).
- **Formatting**: `oxfmt` (config in `.oxfmtrc.json`): `printWidth: 180`, `sortImports`, and `sortPackageJson` enabled.
- **Linting**: `pnpm lint` runs frontend `oxlint`, `oxfmt --check`, and `vue-tsc`, then the worker's own lint script.
- **Env files**: `.env.development` / `.env.production` — PostHog keys (`VITE_POSTHOG_*`) and an optional `VITE_CESIUM_ION_TOKEN`. See `.env.example`.
- **Cesium ion**: `src/config/ion.ts` carries a committed token **restricted to satvis.space**, set once as `Ion.defaultAccessToken`. It backs Cesium World Terrain and both surface models, and ion rejects it on localhost, on `deploy:preview` origins, and in foreign iframes — so local work on those features needs an unrestricted token in `VITE_CESIUM_ION_TOKEN`. Without one they fail loudly (a toast, and the surface model reverts to `None`) rather than silently. See `docs/adr/0005-surface-models.md`.
- **Not-found handling is `404-page`, and `public/404.html` is load-bearing.** `single-page-application` answered every unmatched path with `index.html` and a 200, which made `response.ok` meaningless for probes and let the service worker cache the app shell under tile urls. The bargain is that every path which must serve the app has to resolve to an asset, which `/ot` does through a `_redirects` 200 rewrite rather than a duplicated html file, and everything left over genuinely 404s. **All of it stays in the asset router, so none of it is a billed Worker request:** measured with a log in the fetch handler, requests to `/`, `/ot`, an unknown route, a missing tile and a missing GP snapshot invoked the Worker zero times, and only `/api/*` did. Delete `404.html` and that stops being true — without it the router falls through to the Worker and every missing file becomes a billed invocation.
- **PWA**: Service worker via `vite-plugin-pwa` with Workbox caching strategies. One rule is load-bearing beyond performance: `assets.ion.cesium.com` is cached for 30 days, and it is scoped to that host because Google's photorealistic tiles come from `tile.googleapis.com` and their Map Tiles policies restrict caching. Do not widen that pattern.
- **`navigateFallbackDenylist` is about navigations only.** Workbox's `NavigationRoute` rejects any request whose `mode` is not `navigate` _before_ it reads the denylist, so this list cannot change what a `fetch()` receives — a probe that has to tell a real file from the app shell must read the body (see the imagery probe in `CesiumLayerProviders.ts`). What it does control is opening a data url directly: `/api/`, `/data/` and `/cesium/` are denylisted by prefix so that, for example, `https://satvis.space/api/groups.json` in the address bar reaches the Worker instead of being answered with `index.html`. An extension list alone missed it, `.json` not being in it.
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

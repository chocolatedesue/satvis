# [satvis.space](https://satvis.space) ![Node CI](https://github.com/Flowm/satvis/workflows/Node%20CI/badge.svg)

Satellite orbit visualization and pass prediction.

> [!NOTE]
> The `next` branch contains many improvements from a bigger refactoring and is the recommended branch currently.
> This version is currently deployed to [satvis.space](https://satvis.space).
> Planning to merge this back to the ~~master~~ main in the next few months.

![Screenshot](https://user-images.githubusercontent.com/1117666/47623704-f0c3e900-db14-11e8-9cf9-7bf13acb267c.png)

## Features

- Calculate position and orbit of satellites from CelesTrak GP element sets (OMM/TLE)
- Set groundstation through geolocation or pick on map
- Calculate passes for a set groundstation
- Local browser notifications for passes
- Serverless architecture
- Works offline as Progressive Web App (PWA)

## Built With

- [CesiumJS](https://cesiumjs.org)
- [Satellite.js](https://github.com/shashwatak/satellite-js)
- [Vue.js](https://vuejs.org)
- [Nuxt UI](https://ui.nuxt.com)
- [Cloudflare Workers](https://workers.cloudflare.com)
- [Workbox](https://developers.google.com/web/tools/workbox)

## Development

### Setup

Initialize submodules and install build dependencies:

```
git submodule update --init
mise trust && mise install   # toolchain (Node 24, pnpm 11, prek; see mise.toml)
mise setup                   # install the pre-commit hooks
pnpm install
```

A single `pnpm install` at the repository root installs dependencies for both
the SPA and the `worker/` package.

### Run

- `pnpm dev` for the dev server (proxies `/api` to <https://satvis.space>, so
  satellite data works without a local worker)
- `pnpm dev:host` to expose the dev server on the local network
- `pnpm build` to build the application (output in `dist` folder)
- `pnpm preview` to preview the production build locally
- `pnpm update-gp` to refresh the static satellite-data snapshot (see below)

### Full-stack dev (with the worker)

To run the frontend against a local worker instead of the deployed API:

```
pnpm dev:worker                                     # wrangler dev on :8080
SATVIS_API_PROXY=http://localhost:8080 pnpm dev     # frontend proxies /api → local worker
```

The worker's cron trigger fills Workers KV. To run it once locally (wrangler
dev is started with `--test-scheduled`), hit the scheduled endpoint:

```
curl "http://localhost:8080/__scheduled?cron=23+*%2F3+*+*+*"
```

Then `GET /api/groups.json` lists the refreshed groups and
`GET /api/gp/starlink.json` returns an OMM element-set array.

## Satellite data

Element sets come from [CelesTrak](https://celestrak.org) as OMM JSON
(CelesTrak is phasing out TLE for new objects). The Cloudflare Worker in
`worker/` fetches and serves them:

- A cron trigger (every 3 h) refreshes each group into Workers KV; failed
  sources keep the last-known-good copy.
- `GET /api/gp/<group>.json` — one group's element sets (OMM array).
- `GET /api/groups.json` — the group index (also the frontend's worker probe).
- `GET /api/metadata.json` — per-satellite metadata rules (see below).

Groups are **declarative**, not shell scripts:

- Core groups live in `worker/src/config/groups.core.json` (CelesTrak
  pass-throughs, e.g. `{ "name": "starlink", "sources": [{ "celestrak": "starlink" }] }`).
- Plugins add `data/custom/<plugin>/groups.json` with
  `sources` / `select` / `rename` / `include` / `extraRecordsFile`. Example
  (`data/custom/example/groups.json`):

  ```json
  {
    "groups": [
      {
        "name": "iss",
        "sources": [{ "celestrak": "stations" }],
        "satellites": [{ "noradId": 25544, "upstreamName": "ISS (ZARYA)", "name": "ISS" }]
      }
    ]
  }
  ```

`pnpm --filter satvis-worker generate-groups` merges the core config with every
`data/custom/*/groups.json` (inlining `extraRecordsFile` element sets) into the
gitignored `worker/src/config/groups.generated.json` used by the worker.

### Worker-less deployments

For plain static hosting (or forks without a worker), run
`pnpm update-gp` before `pnpm build`. It runs the same group evaluator as the
cron and writes a static snapshot into `data/gp/` (`<group>.json`,
`index.json`, `metadata.json`; gitignored). At runtime the app probes
`/api/groups.json`; if that fails it falls back to the static `data/gp/`
snapshot, so all presets keep working without the worker.

### Satellite metadata

Per-satellite metadata (e.g. sensor swath width, cone FOV, model URL) is
resolved from the built-in rules in `src/config/satelliteMetadata.ts`, extended
by optional remote rules. Plugins declare remote rules via a `metadata` array
in their `groups.json`; those are merged and served at `/api/metadata.json` and
applied on top of the app rules.

## iOS App

To provide pass notifications on iOS where local browser notifications are [not
supported](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API#Browser_compatibility)
a simple app wraps the webview and handles the scheduling of
[UserNotifications](https://developer.apple.com/documentation/usernotifications).

<p align="center"><a href="https://apps.apple.com/app/satvis/id1441084766"><img src="src/assets/app-store-badge.svg" width="250" /></a></p>

## License

This project is licensed under the MIT License - see `LICENSE` file for details.

## Acknowledgements

Inspired by a visualization developed for the [MOVE-II CubeSat project](https://www.move2space.de) by Jonathan, Marco and Flo.

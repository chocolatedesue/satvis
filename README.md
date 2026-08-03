# [satvis.space](https://satvis.space) [![CI](https://github.com/Flowm/satvis/actions/workflows/ci.yml/badge.svg)](https://github.com/Flowm/satvis/actions/workflows/ci.yml)

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
- `pnpm update-imagery` to build the offline base map (needs docker; see below)

### Full-stack dev (with the worker)

To run the frontend against a local worker instead of the deployed API:

```
pnpm dev:worker                                     # wrangler dev on :8080
SATVIS_API_PROXY=http://localhost:8080 pnpm dev     # frontend proxies /api → local worker
```

The worker's cron trigger fills Workers KV. To run it once locally (wrangler
dev is started with `--test-scheduled`), hit the scheduled endpoint:

```
curl "http://localhost:8080/__scheduled?cron=23+*%2F6+*+*+*"
```

Then `GET /api/groups.json` lists the refreshed groups and
`GET /api/gp/starlink.json` returns an OMM element-set array.

`POST /api/refresh` runs the same refresh on demand and reports per-source
diagnostics. It needs a bearer token, since one run pulls ~7 MB from CelesTrak
against a 250 MB/day per-IP cap:

```
curl -X POST -H "Authorization: Bearer $REFRESH_TOKEN" http://localhost:8080/api/refresh
```

Locally the token comes from `worker/.dev.vars` (copy `worker/.dev.vars.example`);
deployed it is a Worker secret, set with `wrangler secret put REFRESH_TOKEN`.
With no secret set the endpoint returns 503 rather than running unauthenticated.

## Satellite data

Element sets come from [CelesTrak](https://celestrak.org) as OMM JSON
(CelesTrak is phasing out TLE for new objects). The Cloudflare Worker in
`worker/` fetches and serves them:

- A cron trigger (every 6 h) refreshes each group into Workers KV; failed
  sources keep the last-known-good copy.
- `GET /api/gp/<group>.json` — one group's element sets (OMM array, with
  per-satellite metadata attached; see below).
- `GET /api/groups.json` — the group index (also the frontend's worker probe).

Configuration is **declarative** YAML, not shell scripts. Each config file
contributes two independent sections: `groups` (what is served, as which unit) and
`satellites` (static per-satellite facts, keyed by NORAD id).

- The core config lives in `worker/src/config/satvis.core.yaml` (CelesTrak
  pass-throughs, plus the satellite table).
- Plugins add `data/custom/<plugin>/satvis.yaml` with
  `sources` / `select` / `rename` / `include` / `extraRecordsFile`. Example
  (`data/custom/example/satvis.yaml`):

  ```yaml
  groups:
    - name: iss
      sources: [{ celestrak: stations }]
      satellites:
        - { noradId: 25544, upstreamName: ISS (ZARYA), name: ISS }
  ```

`pnpm --filter satvis-worker generate-groups` merges the core config with every
`data/custom/*/satvis.yaml` (inlining `extraRecordsFile` element sets) into the
gitignored `worker/src/config/satvis.generated.json` used by the worker.

### Worker-less deployments

For plain static hosting (or forks without a worker), run
`pnpm update-gp` before `pnpm build`. It runs the same refresh pipeline as the
cron — including metadata enrichment — and writes a static snapshot into
`data/gp/` (`<group>.json`, `index.json`; gitignored). At runtime the app probes
`/api/groups.json`; if that fails it falls back to the static `data/gp/`
snapshot, so all presets keep working without the worker.

### Offline base map

The `NaturalEarth` layer — the default base map, and the one that keeps the globe
usable with no network — is **part committed, part generated**. Levels 0–2 are in the
repository (42 WebP tiles, 0.35 MB), so a fresh clone already renders a correct globe.
The sharp levels are built on demand:

```
pnpm update-imagery
```

That runs a container (`scripts/imagery/`) which fetches [Natural Earth
II](https://www.naturalearthdata.com/downloads/10m-raster-data/) at 10m, applies the
colour grade the original Cesium tileset was cut with, and writes levels 3–5 into the
gitignored part of `data/imagery/` — about 17.2 MB more, and a minute on a warm cache.
Docker is the only host requirement; GDAL runs inside.

The build raises the zoom ceiling when it sees those levels, so skipping the generator
costs sharpness and nothing else: the globe still works, capped at level 2, and goes
soft when you zoom in. **Run it before `pnpm deploy`, though** — the build only warns,
so a deploy without it ships that cap. Running it during a `pnpm dev` session needs a
restart to take effect.

Levels 0–3 (1.4 MB) are precached by the service worker, so the globe is complete
offline wherever it is turned; 4 and 5 are cached as they are requested, and anywhere
you have not been shows level 3 magnified rather than nothing at all.
`pnpm update-starmap` does the same job for the optional star maps.

### Satellite metadata

Static per-satellite facts — per-side swath extents, sensor cone FOV, model URL,
operator — live in the `satellites` table of `satvis.core.yaml` (and of any plugin
config), keyed by NORAD id. The refresh attaches each matching satellite's facts to
its served record under a lowercase `metadata` key, so metadata travels with the
element set instead of being matched against a separate rule list in the browser.
Satellites absent from the table carry no metadata and fall back to the defaults in
`src/config/satelliteMetadata.ts`.

Swath extents are **per-side** cross-track distances from the ground track,
relative to flight direction — not halves of a total width, because a tilted sensor
reaches further one way than the other. See
`docs/adr/0002-static-satellite-metadata.md`.

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

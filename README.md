# [satvis.space](https://satvis.space) [![CI](https://github.com/Flowm/satvis/actions/workflows/ci.yml/badge.svg)](https://github.com/Flowm/satvis/actions/workflows/ci.yml)

3D satellite tracker and pass predictor.

Satvis is a free, open-source satellite tracker that runs in the browser.
It draws more than 12,000 satellites on a 3D globe in real time and works out when each one passes over a ground station you set.
The sky view trades the globe for a ground-level camera aimed by your phone's compass and gyroscope, so you look for the satellite in the sky rather than on a map of it.

![Screenshot](https://user-images.githubusercontent.com/1117666/47623704-f0c3e900-db14-11e8-9cf9-7bf13acb267c.png)

## Features

- Visualize more than 12,000 satellites on a 3D globe in real time, propagated in the browser with SGP4 from CelesTrak GP element sets (OMM/TLE)
- Draw points, labels, orbits, orbit tracks, ground tracks, sensor cones and 3D models per satellite, coloured by orbit class (LEO, MEO, GEO, HEO)
- Switch any of the 14 catalog groups on and off (Starlink, GNSS, weather, Earth observation, crewed stations), or search out a single satellite
- Set ground stations from geolocation or a point you pick on the map, then list their upcoming passes and get a local browser notification before one starts
- Show the globe in 3D, flattened to 2D or in Columbus view, over a base map, star field and terrain you choose
- Find a satellite in the sky overhead rather than on a map, in a ground-level sky view aimed by your phone's compass and gyroscope and walked with the movement keys
- Add OpenStreetMap buildings to the globe, or Google's photorealistic tiles under the sky view
- Generate a Walker Delta or Walker Star constellation from its `i: T/P/F` specification and fly it beside the real catalog, with every per-satellite visual the real ones get
- Colour satellites by what the sun is doing to them — eclipse (ν) _and_ solar panel incidence (κ) — as a point colour, and as the orbit line itself cut into sunlit, penumbra and back-sun arcs
- Read one satellite's eclipse and back-sun budget over its next two orbits, as percentages and as a strip of colour
- Share the exact view you are looking at as a link: the url carries the satellites, the components, the ground station and the map layers
- Install it as a Progressive Web App and keep using it offline, from a cached element-set snapshot and base map
- Deploy it serverless: static files on a CDN, with an optional Cloudflare Worker serving fresh satellite data

Every parameter in that url is specified in `docs/adr/0001-url-parameter-specification.md`.

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

`POST /api/ingest` takes the same token and does the same work on payloads the
caller already downloaded, for when CelesTrak is refusing Cloudflare's egress
(see [Downloading off-Worker](#downloading-off-worker)).

## Satellite data

Element sets come from [CelesTrak](https://celestrak.org) as OMM JSON
(CelesTrak is phasing out TLE for new objects). The Cloudflare Worker in
`worker/` fetches and serves them:

- A cron trigger (every 6 h) refreshes each group into Workers KV; failed
  sources keep the last-known-good copy.
- `GET /api/gp/<group>.json` — one group's element sets (OMM array, with
  per-satellite metadata attached; see below).
- `GET /api/groups.json` — the group index (also the frontend's worker probe).

### Downloading off-Worker

CelesTrak firewalls by IP, and Cloudflare's Worker egress addresses are shared
across tenants — so the cron's own fetches can start coming back as `HTTP 522`
on every source while the same URLs answer fine from anywhere else. When that
happens, groups keep serving their last-known-good copy and go stale.

`pnpm --filter satvis-worker push-gp` is the way out. It runs the worker's own
download logic from wherever you run it (a CI runner, a VPS, a laptop) and POSTs
the payloads to `POST /api/ingest`, which runs the unchanged evaluate/enrich/store
pass on them. Only the download moves; the worker still owns the config, the
evaluation and KV.

```
SATVIS_REFRESH_TOKEN=<token> pnpm --filter satvis-worker push-gp
```

`SATVIS_INGEST_URL` overrides the target (default `https://satvis.space/api/ingest`).
Keep the cadence at or above the cron's 6 h — a run still costs ~7 MB of element
sets, just from a different IP, and CelesTrak asks for one download per update.

The same run also refreshes the SATCAT, reading the worker's stored `ETag` from
`/api/groups.json` first so its own download is conditional; the catalog's 6.7 MB
only travels when it actually changed.

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

A plugin may also ship files: `pnpm update-custom-data` runs each
`data/custom/<plugin>/sync.sh` and collects the output into `data/custom/dist/`,
which the build copies into `data/`. The privacy policy behind the credits' link is
one of them.

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

### Orbit lab: Walker constellations and illumination

The **sun button** in the left toolbar opens a panel with two halves.

**Walker constellations.** Enter a pattern in Walker's own notation — `i: T/P/F` plus an
altitude — or pick one of the presets (Iridium-like, the Starlink shells, OneWeb-like),
and press Generate. T satellites are laid out in P planes, each plane offset along-track
from the last by F·360°/T; a RAAN span of 360° is a Walker Delta and 180° a Walker Star.

The pattern is expanded into circular OMM element sets at a fixed epoch and registered in
the catalog under its own tag — `Walker 53:1584/72/17@550` — so everything the app does to a
real satellite it does to a generated one: orbits, ground tracks, sensor cones, pass
prediction, the browser list. It is a _geometry_, not a forecast — no drag term, no
station-keeping, no per-plane epoch. Generating a second pattern replaces the first on
screen; both stay in the satellite browser, so showing them together is one click.

Nothing here needs a rebuild: the numbers are a form, **Show only** draws that pattern alone,
**Add** draws it beside the ones already there, and the panel lists what is live so each can
be switched off, edited or forgotten. The only part that lives in the source is the preset
dropdown (`WALKER_PRESETS`) — a convenience, not a gate.

Patterns travel in the url as a comma-joined list, so a link is a whole scene:

```
# one shell
https://satvis.space/?walker=53:1584/72/17@550&tags=Walker%2053:1584/72/17@550&elements=Point&paint=illumination

# two, side by side
https://satvis.space/?walker=53:1584/72/17@550,97.6:348/6/58@560&tags=Walker%2053:1584/72/17@550,Walker%2097.6:348/6/58@560&elements=Point
```

**Sun-synchronous orbits, and永久 sunlight.** The panel computes the sun-synchronous
inclination for whatever altitude is in the form — by inverting the J₂ nodal precession,
landing within ~0.1° of the published figures for Sentinel-1/-2 and TerraSAR-X — and says
whether a dawn–dusk plane at that altitude ever enters the Earth's shadow. It reports both
sides of the comparison: the worst β of the year against the β the shadow demands.

The answer is a **band, not a floor**: always-sunlit dawn–dusk orbits exist between
**1610 and 3080 km**. Below it the Earth's shadow is still too big; above it sun-synchrony
demands so steep a retrograde inclination that β collapses. No flown dawn–dusk mission is
inside the band — Sentinel-1 at 693 km is eclipse-free for part of the year, not all of it.

**"Always-sunlit SSO demo"** puts that on screen as two orbits at the same altitude and the
same inclination, differing only in how the plane faces the sun: the dawn–dusk one is 0%
eclipsed at both solstices, its noon–midnight twin 28.7%.

**Illumination.** Switch the point colouring from `Orbit class` to `Illumination` and every
satellite is drawn by what the sun is doing to it, over two quantities:

- **ν** — the fraction of the solar disc left uncovered by the Earth, from satellite.js's
  conical shadow model. 0 is umbra, 1 is full sun, between is penumbra.
- **κ** — the signed cosine between the sun and the solar panel's normal.

Which resolve into five states: `umbra`, `penumbra`, `sunlit_back`, `sunlit_edge`,
`sunlit_on`. The third is the one worth having — a satellite in full sunlight whose panel
faces away from the sun has no more power than one in the Earth's shadow, and eclipse alone
reports it as lit.

The five states are shown **two ways**, because they answer different questions:

- the **point colour** says what is happening to a satellite _now_, and needs the clock
  running to be read;
- the **Illumination arc** component draws the _orbit line_ with a colour per vertex, so the
  eclipsed arc, the penumbra slivers either side of it and the arc where the panel has
  turned away are all in view at once, on a paused clock.

**The reference frame matters more than it looks.** An orbit plane is fixed in _inertial_
space, not in the rotating Earth's — so in the **Inertial** frame the orbit holds still and
the Earth turns underneath it, which is what actually happens, while in **Earth-fixed** the
same stationary orbit is drawn sweeping past a motionless globe. The orbit lab surfaces the
control and both demos open in the inertial frame. Fixed is only nearly true: the J₂ bulge
turns every orbit's node a few degrees a day, and the panel reports the rate — the same
number that makes sun-synchronous orbits possible in the first place.

**Start with the "Two-orbit demo" button.** It sets up the smallest scene that shows all of
it: two orbital planes 90° apart with ten satellites each, arcs on, points enlarged and
coloured to match, and the clock at 60× so an orbit takes about a minute and a half — long
enough to watch a satellite cross from the sunlit arc into the eclipsed one and change colour
as it goes. Point size is its own control (5, 9 or 14 px): 5 px is what keeps a full Starlink
activation from hiding the globe, and too small to read a colour off.

κ is a **model, not a measurement**: no GP element set carries attitude, so the panel
normal is assumed. Which assumption is yours to pick (`Panel normal`: zenith, velocity,
orbit normal) and is named in the readout. The default is a body-fixed panel on the
anti-Earth face of a nadir-pointing bus, the one choice whose κ changes sign within an
orbit.

The panel also shows a live census of the states across everything on screen, and for the
satellite you click: its current ν, κ and beta angle, and a strip of its next **two** orbits
with the share spent in each state — two rather than one, because one orbit cannot show what
changes between them. Reasoning and alternatives are in
`docs/adr/0007-orbit-lab.md`.

### Satellite metadata

Static per-satellite facts are keyed by NORAD id in one satellite table with two
contributors:

- **Curated** — per-side swath extents, sensor cone FOV, model URL, operator —
  hand-written in the `satellites` table of `satvis.core.yaml` (and of any plugin
  config), for the couple of dozen satellites worth saying something specific about.
- **Upstream** — owner, launch date, launch site, operational status, orbit type
  and centre — from the CelesTrak [SATCAT](https://celestrak.org/satcat/), which
  covers every satellite served. Raw SATCAT codes travel on the wire and are
  resolved to labels in `src/config/satcatCodes.ts`.

A curated value wins field by field, so a hand-written row extends its upstream
row rather than replacing it. The refresh attaches the merged facts to each served
record under a lowercase `metadata` key, so metadata travels with the element set
instead of being matched against a separate rule list in the browser. Satellites
in neither table carry no metadata and fall back to the defaults in
`src/config/satelliteMetadata.ts`.

The SATCAT fetch is **conditional**: the stored snapshot keeps the `ETag` it came
with and the next fetch sends it as `If-None-Match`, so the usual refresh costs a
304 with no body. CelesTrak asks for one download per update and the catalog only
changes once or twice a day, against a 6 h cron. `pnpm update-gp` caches its copy
in `worker/.cache/satcat.json` — outside `data/`, because everything there is
copied into the build and this is never served. Deleting it costs one full 6.7 MB
download. A SATCAT failure leaves every group untouched; it only costs enrichment
freshness. See `docs/adr/0006-satcat-enrichment.md`.

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

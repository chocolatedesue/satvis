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
- Wire the generated constellation into the stable inter-satellite topology a propagation derivation picks — rigid intra-plane rings, same-slot inter-plane links, the Walker Star seam dropped — and mark a small cluster of satellites, bonded pairwise even across shells, to watch its geometry hold or shear
- Stack several shells in one scene (`?demo=shells`) with the clock fast enough that the relative motion between them is the thing you see, and design a second shell that holds against the first (`?demo=stable-shells`) instead of shearing away from it
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

### GitHub Pages

`.github/workflows/deploy-pages.yml` builds and publishes that worker-less shape
to `https://<owner>.github.io/<repo>/` on every push to `main` (and on
`workflow_dispatch`). It needs no Vite configuration for the subpath: `base: ""`
already emits relative asset urls, and `upload-pages-artifact` serves the build
as-is with no Jekyll pass. The workflow enables the Pages site itself on its
first run (`configure-pages` with `enablement: true`); on a **fork**, GitHub
disables workflows until the owner presses the button once under
_Actions → I understand my workflows, go ahead and enable them_.

Two things are worse there than on Cloudflare Pages, by construction rather than
by neglect:

- **The globe is capped at imagery level 2**, because `data/imagery/` levels 3–5
  come from `pnpm update-imagery`, which needs docker.
- **`/ot` 404s**, because it resolves through a `_redirects` 200 rewrite that
  only Cloudflare performs. Every other entry point is a real file the MPA build
  emits.

The `pnpm update-gp` step is deliberately non-fatal: CelesTrak firewalls by IP,
and a refused download should cost the real satellites rather than the deploy —
a Walker constellation the orbit lab generates needs no catalog at all.

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

### Constellation links, and a marked cluster

A constellation is a promise about geometry, and a scatter of points does not show it. With
a pattern on screen the app draws the **stable inter-satellite topology** on top — on by
default, `?links=false` to turn it off — with one colour per family, because the families
are the story:

- **Green ring links** inside each plane never change length: equal periods keep the
  spacing exact, measured to a coefficient of variation of 0.001.
- **Violet inter-plane links** join each satellite to its same-slot neighbour in the next
  plane. The along-track offset between the pair is constant forever, so the endpoints never
  re-wire, but the link breathes as the planes cross (CV 0.14–0.27) — watching it swell and
  slacken is watching why this pairing is the one that holds.
- A link that would pass **behind the Earth is hidden**, not drawn through rock. Which
  links are up therefore changes through the orbit — that is part of the reading.
- The **Walker Star seam is never wired**: across it the planes counter-rotate, the
  same-slot pair sweeps past itself at twice orbital rate, and a link there would flicker
  from 1.5 to 14 thousand km. Iridium closes its seam; so does the derivation.
- **Sky-blue bridge links** are the one thing drawn _between_ two patterns, and only when the
  pair is rigid: same altitude and same inclination means equal mean motion and equal node
  rate, so every offset between them is frozen. That pair is one shell flown as two patterns
  — a second RAAN offset, a phased sub-constellation — and it is wired as one, each plane to
  the plane of the other pattern nearest it in right ascension.

These are not tastes but the output of `scripts/derive-isl-topology.mjs`, which flies the
patterns with SGP4 and scores every candidate wiring on length discipline and
nearest-neighbour identity stability. Reasoning and numbers: `docs/adr/0008-constellation-links.md`.

On top of the auto-topology, **Marked cluster** names a small fleet to watch as a unit.
Three buttons in the panel — **Mark one column** (the same slot in every plane of the first
pattern: the halos fly as a rigid ladder), **Mark one per shell** (one satellite from each
pattern, same slot), **Clear marks** — or write the tokens straight into the url as a
comma-joined `mark=` list, each `<plane>-<slot>@<wire>` with 1-based planes and slots:

`walker=` registers a pattern; `tags=` is what switches it on, one `Walker <wire>` per
pattern (the space encodes as `%20`). Without the tags the url draws nothing:

```
# one satellite per shell, bonded pairwise across shells
https://satvis.space/?walker=53:40/4/1@550,70:24/4/1@1200,97.6:24/4/1@1200&tags=Walker%2053:40/4/1@550,Walker%2070:24/4/1@1200,Walker%2097.6:24/4/1@1200&mark=1-1@53:40/4/1@550,1-1@70:24/4/1@1200,1-1@97.6:24/4/1@1200&camera=Inertial
```

Each member carries an **amber halo** and its slot label; every pair is **bonded in amber**,
across planes and across shells, rules aside — because the point of marking is to test
stability by eye exactly where the auto-topology deliberately says nothing. When the chord
between two marked satellites passes behind the Earth, the bond dims to quarter opacity
rather than disappearing, preserving the visual cluster relation across the entire orbit.

Stability across orbits is real, and the bond's line style is the verdict: **solid** means the
pair's geometry comes back, **dashed** means it does not. Which of the five things it is doing
— `rigid`, `repeating`, `phase-locked`, `node-locked` or `drifting` — is on the bond's own
entity, and in the panel's pairwise table. A column holds its geometry for as long as the
constellation flies; a cross-shell cluster shows the solid edges holding while the dashed ones
shear away from them.

**The "Stacked-shells demo"** puts all of it on screen at once: three shells (53° / 550 km,
70° / 1200 km, 97.6° / 1200 km), the topology wired, one satellite per shell marked, and the
clock at 600× so the low shell laps the high ones about every 76 seconds while the amber
triangle shears. The low shell flies 10 per plane on purpose — a ring link clears the Earth
only when `a·cos(π/S) > R`, which at 550 km asks for at least 8 satellites per plane.

### Multi-shell layout: the second shell that holds

Those three shells shear because nobody designed them not to. **No two distinct shells can be
rigid** — freezing the phases wants an equal period, which wants an equal altitude; freezing
the planes wants an equal node rate, which at equal altitude wants an equal inclination; both
at once is the same shell. So a multi-shell layout is designed for _return_ instead, in two
closed-form steps:

1. **Match the node rates.** `Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i`, so the companion's inclination
   follows its altitude directly: `cos i₂ = cos i₁ · (a₂/a₁)^(7/2)`. The planes then hold
   their arrangement instead of shearing.
2. **Close the along-track cycle.** Pick the altitude so `u̇₁ : u̇₂` is a small-integer ratio,
   and the whole configuration returns every `p` orbits of one shell against `q` of the other.

The **Multi-shell layout** section of the orbit lab does both from whatever is in its form,
reports the answer, and **Add the companion shell** puts it on the globe beside the reference:

```
# a 53° / 550 km shell, the 8:7 companion designed to hold against it, and a control
https://satvis.space/?demo=stable-shells

# the designed pair on its own, one satellite of each marked
https://satvis.space/?walker=53:40/4/1@550,34.47:40/4/1@1201.887&tags=Walker%2053:40/4/1@550,Walker%2034.47:40/4/1@1201.887&mark=1-1@53:40/4/1@550,1-1@34.47:40/4/1@1201.887&paint=illumination&psize=large&camera=Inertial
```

Against a 53° / 550 km reference the search returns 6:5 at 1455.8 km / 22.30° (returning every
9.56 h), 7:6 at 1308.1 km / 30.05°, 8:7 at 1201.9 km / 34.47° (12.75 h) and so on. It stops at
a **co-precession ceiling of 1632 km**: above that no inclination precesses slowly enough to
keep up, which is why the short cycles are unavailable. The price of the lock is inclination —
a companion node-locked to 53° / 550 km has to fly at 34.5° by the time it reaches 1200 km.

`scripts/derive-isl-topology.ts` (studies 7–10) flies the result with SGP4 rather than
asserting it. The designed companion's seam shears at **0.005°/day** against 5.21°/day for a
97.6° shell at the same altitude, and one repeat cycle later **99.7%** of satellites find the
same cross-shell partner at a median range change of 4 km — against **79.3%** and 398 km for
the shell that was picked rather than solved. The script also refines the pair against the
propagator (1199.2 km at 34.685°), which is the last 0.2° a secular model cannot see.
`?demo=stable-shells` flies the reference, the designed companion and a 97.6° control together,
so the solid bond returning to its shape and the dashed one wandering are on screen at once.
Reasoning and numbers: `docs/adr/0009-multi-shell-layouts.md`.

### Multi-satellite Space Compute & Live Migration (多星协同与日照区 GPU 利用率优化)

The **"GPU pipeline collaboration demo"** (`?demo=migration` or `?mig=true`) puts a distributed space AI inference pipeline across the constellation. An inference workload (e.g. LLM decode pipeline) is partitioned into 4 stages (1–8 selectable via `?migst=`), each holding its own 2 GB KV cache on distinct satellites connected via 100 Gbps inter-satellite links (ISLs).

Space compute clusters face a fundamental orbital constraint: **on-board GPUs depend on solar power**, which is available only when illuminated (`sunlit_on` / `sunlit_edge`). Entering the Earth's shadow (umbra/penumbra) or turning the solar array away (`sunlit_back`) cuts off primary power. Because pipeline serving is a conjunction across all stages (the entire pipeline produces tokens only when **every stage has power simultaneously**), power loss on a single host satellite stalls the whole pipeline.

Satvis implements two live migration policies (`?migpol=predictive` vs `?migpol=naive`):

1. **Predictive Illumination-Aware Pre-Handoff (`predictive`, Recommended)**:
   - Evaluates orbital illumination lookahead (default 90 s pre-eclipse window).
   - Before a host satellite enters darkness, it proactively schedules an ISL transfer to an idle peer that has line of sight and the longest remaining sunlit duration.
   - The KV-cache migration finishes _before_ power loss occurs, achieving **zero pipeline stalls** and **maximizing sunlit GPU compute utilization (near 100% uptime)**.

2. **Naive Reactive Migration (`naive`, Baseline)**:
   - Waits until solar power is completely lost before triggering migration.
   - Causes pipeline stalls (`stalled`) and drops GPU compute serving uptime to ~30%–45%.

Key metrics and constraints:

- **Line of sight, preferred and reported**: `hasLineOfSight` ranks candidates — a peer the host can see is always taken ahead of one it cannot. It is a preference rather than a
  veto: a host that has turned its panel away sees no powered neighbour over the near limb, and refusing an occluded target left the stage dark for half an orbit while powered
  satellites sat idle on the far side. So when nothing is in view the nearest powered satellite is taken anyway — and the hop is **reported as what it is**: `inView: false` in the
  event log, `⤳ · no direct view` on the halo and in the panel, and a link drawn at a third opacity. A chord through the planet is a two-hop relay, which the fleet has no router
  for yet (see the roadmap in `TODO.md`); what the overlay must not do is draw it as a direct ISL and say nothing.
- **Realistic Link Arithmetic**: Real transfer time accounts for 100 Gbps serialisation (~160 ms for 2 GB) + vacuum light travel over the physical chord distance.
- **Simulated Timebase Ledger**: GPU utilization and served/stalled seconds are tracked accurately against simulated orbit time.

`node scripts/verify-migration.mjs <base-url> <out-dir>` verifies placement, live ISL packet progress, zero-stall serving, and that no hop claims a line of sight it does not have,
in headless Chromium.

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

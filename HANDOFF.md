# Handoff — satvis fork, main branch

State as of 2026-09-02. Read this before touching anything; it is the map of
what exists, what is in flight, and what to do next. `CONTEXT.md` is the
domain glossary; the ADRs in `docs/adr/` are the decisions.

## What this fork is

Upstream is Flowm/satvis (branch `next`, deployed at satvis.space). This fork's
`main` branch adds the **orbit lab** line of work: generated Walker
constellations, illumination (ν/κ) modelling, the naive KV-cache migration
overlay, and — new this session — the **constellation links** overlay and
**marked clusters**. Deployed at two Cloudflare Pages projects (below); the
upstream site knows nothing of these features.

## What was built this session

Commits on `main` (all pushed):

- `0adf423` — constellation links: derivation script + rules + layer + `links=true`
- `fa5391c` — marked clusters (`mark=`), links on by default, panel buttons
- `35b28ad` — docs: ADR 0008, README section, CONTEXT entries, verification record
- `dbb86f9` — deploy script prefers preinstalled wrangler (npx download was the hang)
- `4f43fee` — bond styling: solid = same period (holds), dashed = drifting
- `865b418` — fix(links): keep marked cluster bonds visible with occlusion dimming + `scripts/verify-links.mjs`

The pieces:

- `scripts/derive-isl-topology.ts` — SGP4 propagation studies that justify the
  wiring rules (rerunnable, ~seconds). Study 6 is the cross-orbit answer:
  same-period pairs repeat their distance envelope exactly (3620, 3617, 3621 …
  km), different-period pairs wander without bound (5622 → 14507 → 5077 km).
- `src/modules/util/constellationLinks.ts` — pure rules: intra-plane rings,
  same-slot inter-plane links, seam dropped when orbit normals oppose
  (`wrapPlanesAgree`), nothing between patterns; `resolveMarks` classifies
  bonds `samePeriod` (equal altitude ⇒ equal mean motion).
- `src/modules/ConstellationLinksLayer.ts` — Cesium wiring: rings green,
  inter-plane violet, marked halos + amber bonds (dimmed to 25% opacity when
  Earth-occluded), occlusion pass every 400 ms.
- `scripts/verify-links.mjs` — standalone headless Chrome CDP verification
  for constellation links, marked clusters, bond dash styling, and occlusion dimming.
- `src/modules/util/walkerDelta.ts` — pattern ⇄ OMM records; names carry the
  identity (`W<wire> P01-01`), which `parseWalkerSatellite` reads back.
- URL surface (`docs/adr/0001`): `walker=`, `links=`, `mark=`, `mig=`, `camera=`,
  `paint=`, `psize=`, `elements=`, `tags=`.

## Current Status

- **Bond fade-on-occlusion fix**: COMPLETED & VERIFIED.
- **Headless link verification**: COMPLETED & PASSED (`scripts/verify-links.mjs`).
- **All test suites**: PASSED (1011 frontend vitest tests passed, 107 worker vitest tests passed, 0 linter/type-check warnings).
- **Deployment**: Both Cloudflare Pages deployments updated:
  - `satvis-inertial-frame.pages.dev`
  - `satvis-orbit-lab.pages.dev`

## Deploy runbook

```sh
pnpm update-gp          # refresh data/gp snapshot (gitignored!) — without it the globe is empty
pnpm build
bash scripts/deploy-pages.sh
```

- Deploys the same `dist/` to **satvis-orbit-lab.pages.dev** and
  **satvis-inertial-frame.pages.dev** (account chocolatedesue@gmail.com).
- Credential lives on host **yqh2** at `~/.secrets/cloudflare-pages.env` — a
  `cfk_` Global API Key, used as `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`
  (never as a bearer token; setting `CLOUDFLARE_API_TOKEN` breaks it).
- The script prefers yqh2's preinstalled wrangler (mise install). Do not
  switch it back to `npx -y wrangler@…` — the 50 MB npm download is what hung
  deploys for minutes.
- Roll the Global API Key when convenient (it appeared in plaintext once);
  replace with a Pages:Edit `cfat_` account token.

## Verification runbook

- `pnpm test` — 1011 vitest cases, node env, no Cesium.
- Headless-browser checks follow `scripts/verify-migration.mjs` (CDP, no
  puppeteer; `CHROME_BIN=/usr/bin/google-chrome` here). The links check is
  currently `/tmp/verify-links-live.mjs` — **commit it as
  `scripts/verify-links.mjs`** (next-step item) and point
  `docs/manual-verification.md` at it.
- **This host's IPv6 is broken** (`curl -6` fails instantly) and pages.dev has
  AAAA records, so headless Chrome against the live URL dies with
  `chrome-error://chromewebdata/`. Verify against a local server serving the
  same dist instead — byte-identical to what was deployed:
  ```sh
  (cd dist && python3 -m http.server 8791 --bind 127.0.0.1 &)
  node /tmp/verify-links-live.mjs http://127.0.0.1:8791
  ```
- The HTTP proxy at 127.0.0.1:10800 is intermittently broken; do not route
  verification through it.
- Returning _real_ browsers may hold an outdated service-worker precache;
  that is the PWA updating in the background, not a bad deploy. Fresh
  profiles (what the scripts use) always get the new shell.

## Scene URLs that work right now

- Stacked shells + links + marks: `/?demo=shells`
- Stable cross-plane cluster (same period, all bonds solid):
  `/?walker=70:24/4/1@1200&tags=Walker%2070:24/4/1@1200&paint=illumination&psize=large&elements=Point,Label,Illumination%20arc&camera=Inertial&mark=1-3@70:24/4/1@1200,2-3@70:24/4/1@1200,3-3@70:24/4/1@1200,4-3@70:24/4/1@1200`
- **`walker=` must be accompanied by `tags=Walker%20<same wire>`** — the
  generator only registers records; activation is by tag. A bare `walker=`
  link opens an empty globe.

## Design constraints worth remembering

- Ring links clear the Earth only when `a·cos(π/S) > R`: **S ≥ 8 per plane at
  550 km, S ≥ 6 at 1200 km**. Below that the ring chord runs through the
  ground and is hidden 100 % of the time.
- Marks work only on _generated_ satellites (`parseWalkerSatellite` needs the
  `W<wire> P##-##` name). Real catalog satellites cannot be marked yet.
- One pattern per tag; two patterns never share satnums (hash-banded from
  900000).

## Next steps, in priority order

1. **Finish the in-flight bond fade fix** (see above).
2. **Commit the links verify script** as `scripts/verify-links.mjs`, update
   `docs/manual-verification.md` to reference it instead of `/tmp`.
3. **Smarter migration (LAB-47/70)**: the current policy reacts to darkness.
   A predictive policy — hand the stage off _before_ the eclipse, using the
   illumination arc the app already computes — is the natural next
   experiment; measure against the ledger the overlay already keeps.
4. **Constellation optimizer**: `orbitDesign.ts` already has the closed-form
   (β, eclipse-free fractions). Grid-search (T, P, F, i, h) against
   `pipelineServing` / eclipse-free objectives and render winners through the
   existing `walker=` + `links=` surface.
5. **Mark real satellites**: extend the mark grammar with a name arm
   (`iss@name:ISS (ZARYA)`) so clusters can mix catalog and generated
   satellites; needs positions from `SatelliteManager` only, so the layer
   barely changes.
6. Smaller: per-bond distance readout in the panel; label de-clutter when many
   marks; surface the bond fade in the entity info panel.

---
status: accepted
---

# SATCAT as the satellite table's second contributor

ADR 0002 replaced pattern-matched metadata rules with a NORAD-keyed satellite
table, hand-written in `satvis.core.yaml`. That was the right shape for what it
held — swath extents and sensor cones, calibrated per satellite, each one
transcribed deliberately — but it covers **19 satellites out of the 12,594** the
app serves. Everything else arrives as a name, a catalog number and six orbital
elements, and the app can say nothing about it beyond the orbit class it derives.

CelesTrak's [SATCAT](https://celestrak.org/satcat/satcat-format.php) covers 100%
of the served satnums (verified against a full snapshot, zero misses) and carries
owner, launch date, launch site and operational status at ~100%.

## Decision

**SATCAT is a second contributor to the satellite table, not a group source.**

It selects nothing and serves no records; it only says what is true of a
satellite some group already carries. So it is fetched on its own
(`worker/src/gp/satcat.ts`) rather than through `collectSources`/`fetchSources`,
and `mergeSatelliteTables` folds it into the one map `enrichRecords` already
consumes. **`enrichRecords` itself is unchanged** — the merge happens before it,
so the join, the satnum normalization and the "no entry, no `metadata` key" rule
all stay exactly as ADR 0002 left them.

**Curated wins field by field.** A YAML row supplying only a swath keeps SATCAT's
owner and launch date rather than erasing them. The two tables are not rivals:
the things worth hand-writing are things SATCAT does not carry at all.

**Codes travel, labels resolve at display.** `owner: "US"` is 2 bytes on 11,302
records where "United States" is 13. `src/config/satcatCodes.ts` maps them, and
every lookup falls back to the raw code — these tables go stale by design, and
`SKOR` is a better cell than a blank one.

`SatelliteMetadata` now holds three provenances: **curated** (hand-written, ~19
satellites), **upstream** (SATCAT, all of them), **derived** (`orbitClass`,
computed client-side — see 0002). A reader has to know which one a field came
from to know what its absence means. Nothing upstream may claim the name
`orbitClass`, because `cacheOrbitClass` overwrites that key unconditionally.

## The fetch is conditional, because the cadence does not line up

CelesTrak moved to [one download per update](https://celestrak.org/usage-policy.php)
in March 2026. SATCAT refreshes **once or twice a day**; our cron runs every 6 h.
An unconditional fetch would pull 6.7 MB two to four times over for nothing —
and `pub/satcat.csv` is not gzip-served, so that is 6.7 MB on the wire each time.

It does serve an `ETag`, so the stored snapshot carries the validator from the
body it came from and the next fetch sends it back as `If-None-Match`. The steady
state is a 304 with no body, and **the stored snapshot is therefore the normal
input to enrichment** — not a fallback.

The Worker cannot fetch CelesTrak at all (it firewalls Cloudflare's shared egress;
every source returns HTTP 522), so the download happens off-Worker in
`push-gp.mjs`, which means the validator has to round-trip:

```
push-gp:  GET /api/groups.json           -> satcat.validator
          GET satcat.csv   If-None-Match -> 200 + body | 304
          POST /api/ingest { sources: [...groups, satcat] }
worker:   bundleFetch replays it by URL, ETag included
          304 or failure -> the stored snapshot stands
          200            -> parse, store snapshot + new validator
```

`update-static-gp.mjs` runs the identical path against a disk store with a real
`fetch`, so the two cannot diverge.

**A SATCAT failure costs enrichment freshness and nothing else.** `fetchSatcat`
never throws; groups are fetched, evaluated and stored entirely independently of
it. A refresh with no catalog at all writes every group exactly as it did before
this ADR.

### Consequences accepted

- **~+8 KB gzip across all group payloads** (measured: `starlink.json`
  656 → 663 KB gzip for 10,912 records, `stations.json` 1.4 → 1.8 KB). Far below
  the +36 KB projected, because the values repeat and gzip eats them. Groups load
  on demand, so nobody pays for Starlink unless they enable it.
- **An 8.9 MB stored snapshot** — all 70,244 objects, not just the served ones.
  Trimming it to what the groups currently carry would leave a newly-added group
  unenriched until the next 200, which defeats the conditional fetch.
- **One more upstream request per refresh**, almost always a 304.
- **The raw CSV travels in the ingest bundle** when the catalog does change,
  rather than a pre-parsed table. One parser, one format, and the Worker
  re-validates what it receives — the same fail-closed property the GP sources
  already have.
- **`data/gp/` is no longer the only generated output**: the disk snapshot lives
  in `worker/.cache/satcat.json`, deliberately outside `data/`, because
  everything under `data/` is copied into the build and this is never served.

## Fields not carried

`PERIOD`, `INCLINATION`, `APOGEE`, `PERIGEE` — derivable from the element set
every record already has, and SATCAT rounds them to whole km and minutes. Serving
them would put a rounded second opinion beside the precise one.

`RCS` — 2.9% coverage on the satellites served (20.8% excluding Starlink, which
has none). `DATA_STATUS_CODE` — empty for every one of them.

`OBJECT_TYPE` — 12,583 of 12,594 are `PAY`. Worth revisiting only if a debris or
rocket-body group is ever served.

`OBJECT_NAME` and `OBJECT_ID` — the GP record already carries both.

## What this makes possible that was not

`ORBIT_TYPE`/`ORBIT_CENTER` identify **12 objects that render as independent
satellites but are physically docked** — Nauka, Poisk, Crew Dragon, Progress and
Cygnus on the ISS; Wentian, Mengtian, Tianzhou and Shenzhou on the CSS; Soyuz-MS
in `last-30-days`. They propagate to nearly the same point as their host and
stack eleven labels on top of the ISS. Nothing else in the pipeline knows this,
and the host is named outright: `orbitCenter: "25544"`.

This ADR carries the data and shows `Orbit type: Docked` in the info panel. It
does **not** change how they are drawn — nesting them under the host, or
suppressing the duplicate labels, is a rendering decision with its own design,
and resolving a host satnum to a name needs catalog access `getSatelliteInfo`
does not have.

`OPS_STATUS_CODE` and `DECAY_DATE` also run ahead of CelesTrak's own group
membership: `science` served ODIN after its 2026-08-03 decay, and `planet` serves
FLOCK 4BE-2 at `ops=-`. The app can now say so.

## Alternatives rejected

- **`satcat/records.php?GROUP=active`** — 1.5 MB against 6.7 MB, but it drops 21
  served objects: rocket bodies and debris in `last-30-days`, plus anything that
  decayed since the last catalog roll. Being wrong about exactly the objects
  whose status is changing is the wrong trade, and the conditional fetch makes
  the size difference cost nothing in the steady state.
- **Generating the table at build time** into `satvis.generated.json`. Zero
  runtime cost, and owner/launch date/launch site never change — but
  `last-30-days` is a group of objects launched since the last build, which would
  be permanently unenriched, and `OPS_STATUS_CODE`/`DECAY_DATE` are the fields
  whose whole value is being current.
- **A separate `/api/satcat.json` sidecar** fetched by the frontend: 53 KB gzip
  for all 12,594 satellites, versus ~8 KB inlined. Inlining is both smaller in
  practice and lazy — it rides the group file the browser was already fetching —
  and it needs no second cache entry, no second failure mode, and no client-side
  join.
- **Making SATCAT a `SourceSpec`** so it flows through `collectSources`. It would
  have reused the fetch spacing and logging, but `parseOmmArray` validates every
  source as an OMM array, `SourceFetch.records` is typed `OmmRecord[]`, and
  `evaluateGroups` would carry a source no group names. The type-level
  coincidence that a SATCAT row satisfies `OmmRecord` is not a reason to call it
  one.
- **Storing only the served satnums.** See above — it breaks the moment a group
  is added between two 304s.
- **Expanding codes to labels in the worker.** Bigger payload, and a correction
  would need a full GP refresh instead of a deploy.

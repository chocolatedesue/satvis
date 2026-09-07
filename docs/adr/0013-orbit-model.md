---
status: accepted
---

# The orbit model: one designed orbit, and an analysis layer with no globe in it

`0007` through `0012` each added a way to design an orbit — a Walker pattern, a shell pair, a
stable cluster, an eccentricity lattice. Each one arrived with its own parameter type, its own
copy of the WGS-72 constants and, in two cases, its own copy of the mean motion. Nothing was
wrong: every one of them is right, and the tests that held the copies against each other held.
What was missing is the thing they all agreed on, and it was never written down.

There are two orbits in this repository and only one of them had a name.

## The two faces

**A propagatable orbit** is a GP element set — `GpRecord`, built by `util/gp.ts` from CelesTrak
OMM or TLE text — turned into a satrec and flown by SGP4. It is the contract the whole app
already agrees on, and it is complete: it answers "where is it" to the metre.

**A designed orbit** is the same thing _before_ it is an element set: an altitude, an
inclination, and optionally where the ascending node sits. It cannot be propagated — no epoch, no
drag — and it does not need to be, because every question asked of it is closed form. `Ω̇`, `u̇`,
the period, the sun's elevation above the plane: each is a function of those two numbers alone,
and each is what a constellation is actually designed against.

`CircularOrbit` in `src/modules/util/orbitModel.ts` is the second of those. A Walker pattern's
orbit, a cluster's orbit, a `ShellOrbit` and one cell of a design sweep are now all that type
under a local name, which is what lets them be handed to each other.

## Why not one union type

The obvious move is `OrbitModel = GpRecord | WalkerDeltaParams | ClusterFormationParams`, one
type for "an orbit". It is the wrong move, for two reasons that are the same reason.

- **The discrimination is behavioural, not structural.** A `GpRecord` can be propagated; a
  designed orbit cannot. Folding them into one type pushes that test into `Orbit` and
  `SampledTrajectory`, each of which only ever wants one arm — so every one of their call sites
  gains a narrowing it should never have had to write.
- **The wire forms do not unify.** `encodeWalker` and `encodeCluster` are different languages,
  and a url is one or the other. A shared type would promise a shared codec that does not exist.

What the two arms genuinely share is the _shape of the design-time parameters_. That is the part
worth unifying, and it is now unified by inheritance rather than by discrimination.

## Why the rates are closed form, and what that is worth

Both secular rates of a circular orbit are one line — `Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i` and
`u̇ = ṁ + ω̇` — and neither needs a satrec. So a design question is answered for hundreds of
candidate orbits in the time one `sgp4init` takes, and the answer is a property of the design
rather than of a date. `0009` matches node rates across shells, `0010` partitions a fleet on
them, and `0007` inverts one for the sun-synchronous inclination: all three read the same two
numbers.

The cost, stated once here rather than per generator: these are two-body answers. SGP4 recovers a
semi-major axis from a Kozai mean motion with J₂ in it, so a generated pattern flies a few
kilometres off the altitude it was quoted at — around 6 km at 550 km, checked in the tests. That
band is what a constellation design is quoted to, and it is why three period entries survive
rather than one:

| entry                                     | needs       | use                                       |
| ----------------------------------------- | ----------- | ----------------------------------------- |
| `approximatePeriodMinutes` (`util/gp.ts`) | nothing     | classifying ~10,000 records at parse time |
| `circularPeriodMinutes`                   | an altitude | a design that has no element set yet      |
| `propagatedPeriodMinutes`                 | a satrec    | anything that places a satellite in time  |

Merging them would mean either building 10,000 satrecs to classify a catalog, or sizing a sample
grid from a period the propagator does not fly.

## Three duplicated things, and the one that stays

- **The WGS-72 constants** were spelled out in five modules. They are now exported from
  `orbitModel`, and `shellLayout` imports them rather than restating them.
- **The mean motion** was restated in `shellLayout` (and a fourth time inside
  `formationSnapshot`). `shellRates` is now literally `orbitalRates`.
- **The node offset's range** was validated twice with the same sentence. It is one predicate,
  `raanOffsetError`.

The duplication that stays is `parseTleText`, which `util/gp.ts` already forbids unifying with
the worker's copy: the two have deliberately opposite error policies.

## An analysis layer you can run

The second half of this decision is that none of it needs a browser. `src/modules/util/` is
Cesium-free and Vue-free, so the same modules the orbit lab panel reads are driven from a
terminal by `scripts/orbit-lab.ts` (`pnpm orbit-lab orbit 550 53`), with no build step. That is a
property worth defending: a closed-form model whose only reader is a Vue panel cannot be checked
against a paper without loading a globe.

It imposes one constraint, and it is the interesting one. Node's type stripping resolves no
specifier a bundler would have to, so any module a script can reach must carry its own `.ts`
extension on import — which is why `orbitModel` is imported as `./orbitModel.ts` where the rest
of `src/` omits it. `@vue/tsconfig` already sets `allowImportingTsExtensions`, so the cost is one
unusual specifier per importer; the alternative is a generator that cannot be run outside a
bundler at all.

## Consequences

- A shell, a pattern, a cluster and a sweep cell are interchangeable at the call site.
- The secular rates have one implementation, so `shellLayout`, `sunSynchronous` and the orbit lab
  cannot disagree about a node rate.
- Every design question in this repository is answerable from a terminal.
- `illuminationAt` and `formationSnapshot` still take a satrec, deliberately: κ needs position
  and velocity from the same instant, and a formation's radial/along-track split is defined in
  TEME. Reading the interpolated pseudo-fixed positions the globe holds would tilt the along-track
  axis by about four degrees. That is not a missing abstraction; it is the frame the maths is in.

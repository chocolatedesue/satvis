// How far is the nearest satellite that still has power, at the moment one loses
// it? And how long does the answer stay true?
//
//   node --experimental-strip-types scripts/research/migration-reach.ts
//   node --experimental-strip-types scripts/research/migration-reach.ts sweep planes
//
// The migration model (src/modules/util/migration.ts) answers "where does this KV
// cache go" per frame, and the energy report (docs/starlink-energy-report.md)
// answers "how much of an orbit has power". Neither answers the question between
// them, which is the one a hand-off budget is actually built on: **when a host goes
// dark, how far away is the satellite that takes over, and how long before that one
// goes dark too.**
//
// The distance is not a property of the eclipse. It is a property of the *local
// spacing* of the pattern — how far apart a Walker pattern puts its satellites in
// the neighbourhood of the terminator — crossed with how much remaining sunlight
// the policy demands of the target. Those are two different knobs (T/P/F/h/i on one
// side, the lookahead window on the other), and separating them is what this script
// is for.
//
// Everything here is measured by propagation, not asserted: the same SGP4 the app
// flies, the same ν/κ illumination channels the globe is painted with
// (`illuminationOf`), the same line-of-sight rule and around-the-limb routing the
// migration layer hands off through (`hasLineOfSight`, `routesFrom`).
//
// Node >= 22 strips the types of the imported src modules natively, which is why
// every src import below carries its `.ts` extension. See the header of
// src/modules/util/orbitModel.ts.

import { json2satrec, propagate } from "satellite.js";

import type { PanelAxis } from "../../src/config/illumination.ts";
import { DEFAULT_KV_GIGABYTES, ISL_GBPS } from "../../src/config/migration.ts";
import { illuminationOf, sunGeometry } from "../../src/modules/util/illumination.ts";
import {
  chooseRouteExcluding,
  distanceKm,
  hasLineOfSight,
  noPower,
  routeTransferCost,
  routesFrom,
  type MigrationHost,
  type MigrationRoute,
} from "../../src/modules/util/migration.ts";
import { encodeWalker, satsPerPlane, walkerDeltaRecords, type WalkerDeltaParams } from "../../src/modules/util/walkerDelta.ts";

// ---------------------------------------------------------------------------
// What counts as "has power", and what counts as a policy
// ---------------------------------------------------------------------------

/**
 * The two honest readings of "this satellite cannot compute".
 *
 * - `panel` is the app's own definition (`noPower`): only `sunlit_on` and
 *   `sunlit_edge` power a load, so a satellite whose panel has turned away is dark
 *   even in full sun. This is the model the globe and the migration layer run.
 * - `eclipse` is geometry alone — umbra and penumbra — and is what "进入日影" means
 *   literally. It is here because the two give materially different answers and a
 *   reader deserves to know which one a figure came from: the panel model is a
 *   *model* (nothing in an element set describes attitude), the eclipse is not.
 */
type PowerModel = "panel" | "eclipse";

function poweredIn(state: string, model: PowerModel): boolean {
  return model === "panel" ? !noPower(state) : state !== "umbra" && state !== "penumbra";
}

/**
 * A hand-off policy, as the one number that distinguishes them: how much warning it
 * takes and how much remaining sunlight it demands of the target.
 *
 * `lookaheadSeconds` 0 is the naive reactive policy — migrate once the power is
 * already gone, to the nearest lit satellite, with no question asked about how long
 * that one stays lit. Anything above 0 is the predictive family: trigger that many
 * seconds *before* the host goes dark, and prefer a target still lit at the end of
 * the same window (`chooseRouteExcluding`'s `preferLookahead`, which is exactly what
 * `decideStageMigration` passes under the `predictive` policy).
 *
 * 90 s is the app's `MIGRATION_PREDICTIVE_LOOKAHEAD_SIM_SECONDS`. The longer windows
 * are not implemented policies, they are the question "what would demanding more
 * dwell cost in distance" asked at three depths.
 */
interface Policy {
  label: string;
  lookaheadSeconds: number;
}

const POLICIES: readonly Policy[] = [
  { label: "naive (reactive, 0 s)", lookaheadSeconds: 0 },
  { label: "predictive 90 s", lookaheadSeconds: 90 },
  { label: "predictive 300 s", lookaheadSeconds: 300 },
  { label: "predictive 600 s", lookaheadSeconds: 600 },
];

// ---------------------------------------------------------------------------
// Flying the pattern
// ---------------------------------------------------------------------------

const PANEL_AXIS: PanelAxis = "zenith";
const EARTH_RADIUS_KM = 6371;
const LINK_MARGIN_KM = 80;

/** One satellite's whole history: position per step (metres), power per step. */
interface Flight {
  names: string[];
  planes: number[];
  slots: number[];
  /** `positions[step][sat]`, in **metres**, which is the frame `migration.ts` works in. */
  positions: Array<Array<{ x: number; y: number; z: number }>>;
  /** `power[step][sat]` under the chosen power model. */
  power: boolean[][];
  /** `eclipsed[step][sat]` — umbra or penumbra, independent of the panel model. */
  eclipsed: boolean[][];
  /**
   * `latitude[step][sat]` in degrees, geocentric.
   *
   * Here because *where* on the orbit a hand-off happens is part of the answer: the
   * planes of an inclined constellation converge towards the turning latitude, so a
   * hand-off made up there is between satellites that are close for a reason that has
   * nothing to do with how many of them there are.
   */
  latitude: number[][];
  stepSeconds: number;
  steps: number;
}

/**
 * How many hops the hand-off would take over the **fixed ISL lattice**, rather than
 * over free space.
 *
 * The migration model routes over the *visibility* graph: any two satellites that
 * can see each other are one hop apart (`routesFrom`). The topology the app actually
 * draws is not that graph — `./constellationLinks.ts` wires a ring inside each plane
 * and a same-slot link between *adjacent* planes, and nothing else. A fleet whose
 * radios are installed that way cannot take the direct chord to a satellite four
 * planes over, however clearly it can see it: it has to walk there.
 *
 * So this is the same hand-off priced under the other assumption — |Δplane| plane
 * steps plus |Δslot| ring steps, each a store-and-forward leg. Rings always wrap, so
 * the slot distance is the shorter way round; planes wrap only when the pattern
 * spans the full 360°, because a Walker Star's seam planes counter-rotate and the
 * wrap link is dropped there (`docs/adr/0008`).
 */
function latticeHops(flight: Flight, from: number, to: number, planeCount: number, slotCount: number, wrapsPlanes: boolean): number {
  const planeGap = Math.abs((flight.planes[to] as number) - (flight.planes[from] as number));
  const slotGap = Math.abs((flight.slots[to] as number) - (flight.slots[from] as number));
  return (wrapsPlanes ? Math.min(planeGap, planeCount - planeGap) : planeGap) + Math.min(slotGap, slotCount - slotGap);
}

/** Two-body period of the labelled circular orbit, in seconds. */
function periodSeconds(altitudeKm: number): number {
  const radiusKm = 6378.135 + altitudeKm;
  return 2 * Math.PI * Math.sqrt(radiusKm ** 3 / 398600.8);
}

/**
 * Propagate the whole pattern over `orbits` revolutions and record, per step, every
 * satellite's position and whether it has power.
 *
 * One pass rather than one per policy: the policies differ only in when they read
 * this table, so measuring them against the *same* flight is what makes their
 * numbers comparable rather than merely similar.
 */
function fly(params: WalkerDeltaParams, epoch: Date, orbits: number, stepSeconds: number, model: PowerModel): Flight {
  const records = walkerDeltaRecords(params, epoch, "W", 900000);
  const satrecs = records.map((record) => (record.kind === "omm" ? json2satrec(record.omm) : undefined));
  const names = records.map((record) => (record.kind === "omm" ? record.omm.OBJECT_NAME : ""));
  const perPlane = satsPerPlane(params);
  const planes = names.map((_, index) => Math.floor(index / perPlane));
  const slots = names.map((_, index) => index % perPlane);
  const steps = Math.floor((periodSeconds(params.altitudeKm) * orbits) / stepSeconds) + 1;

  const positions: Flight["positions"] = [];
  const power: boolean[][] = [];
  const eclipsed: boolean[][] = [];
  const latitude: number[][] = [];
  for (let step = 0; step < steps; step += 1) {
    const time = new Date(epoch.getTime() + step * stepSeconds * 1000);
    const sun = sunGeometry(time);
    const framePositions: Array<{ x: number; y: number; z: number }> = [];
    const framePower: boolean[] = [];
    const frameEclipsed: boolean[] = [];
    const frameLatitude: number[] = [];
    for (let sat = 0; sat < satrecs.length; sat += 1) {
      const satrec = satrecs[sat];
      const state = satrec ? propagate(satrec, time) : undefined;
      if (!state?.position || !state.velocity || !sun) {
        framePositions.push({ x: 0, y: 0, z: 0 });
        framePower.push(false);
        frameEclipsed.push(true);
        frameLatitude.push(Number.NaN);
        continue;
      }
      // Position in metres for migration.ts; illumination takes the same vector in km.
      framePositions.push({ x: state.position.x * 1000, y: state.position.y * 1000, z: state.position.z * 1000 });
      const illumination = illuminationOf(state.position, state.velocity, sun, PANEL_AXIS);
      const illuminationState = illumination?.state ?? "umbra";
      framePower.push(poweredIn(illuminationState, model));
      frameEclipsed.push(illuminationState === "umbra" || illuminationState === "penumbra");
      // Geocentric latitude: enough to say *where on the orbit*, and it needs no earth
      // model, unlike the geodetic one.
      const radiusKm = Math.hypot(state.position.x, state.position.y, state.position.z);
      frameLatitude.push((Math.asin(state.position.z / radiusKm) * 180) / Math.PI);
    }
    positions.push(framePositions);
    power.push(framePower);
    eclipsed.push(frameEclipsed);
    latitude.push(frameLatitude);
  }
  return { names, planes, slots, positions, power, eclipsed, latitude, stepSeconds, steps };
}

// ---------------------------------------------------------------------------
// Choosing a target, the way the app chooses one
// ---------------------------------------------------------------------------

/**
 * The target `chooseRouteExcluding` would pick, computed without building the whole
 * visibility graph when it does not have to.
 *
 * The tiers that function applies are: lookahead-safe **and** direct, direct,
 * lookahead-safe by relay, by relay — shortest wire within a tier. The first two
 * tiers only ever contain direct links, and a direct link is by definition the
 * shortest path between its two ends, so when *any* powered candidate is in view the
 * answer is decided by an O(N) scan and the Dijkstra is wasted work. Only when the
 * source can see nothing lit does the relayed search have to run at all, and that is
 * rare enough to pay for.
 *
 * This is an optimisation, not a second model: `checkAgainstApp` below asserts the
 * two agree on a random sample of the events actually measured, so if the tiering
 * in `migration.ts` ever changes, this script fails rather than quietly reporting
 * the old policy.
 *
 * `fleet` is the relay pool and is separate from `candidates` for the reason it is
 * separate in `chooseRouteExcluding`: a satellite can be disqualified as a *host* —
 * it will not stay lit long enough — and still be a perfectly good *relay*, because
 * forwarding a cache takes seconds and hosting it takes minutes. Filtering the relay
 * pool by the host requirement is what made a 1200 s demand read as unreachable when
 * it was merely not in view.
 */
function chooseRoute(
  source: MigrationHost,
  candidates: readonly MigrationHost[],
  preferLookahead: boolean,
  fleet: readonly MigrationHost[] = candidates,
): MigrationRoute | undefined {
  let directSafe: MigrationRoute | undefined;
  let direct: MigrationRoute | undefined;
  for (const candidate of candidates) {
    if (candidate.name === source.name || !candidate.hasPower) {
      continue;
    }
    if (!hasLineOfSight(source.position, candidate.position)) {
      continue;
    }
    const km = distanceKm(source.position, candidate.position);
    const route: MigrationRoute = { hops: [source.name, candidate.name], legsKm: [km], linkKm: km };
    if (preferLookahead && candidate.lookaheadPower !== false) {
      if (!directSafe || km < directSafe.linkKm) {
        directSafe = route;
      }
    }
    if (!direct || km < direct.linkKm) {
      direct = route;
    }
  }
  if (directSafe ?? direct) {
    return directSafe ?? direct;
  }
  // Nothing lit is in view: the hand-off has to go around the limb, or not at all.
  const routes = routesFrom(source, fleet);
  let safest: MigrationRoute | undefined;
  let shortest: MigrationRoute | undefined;
  for (const candidate of candidates) {
    if (candidate.name === source.name || !candidate.hasPower) {
      continue;
    }
    const route = routes.get(candidate.name);
    if (!route) {
      continue;
    }
    if (preferLookahead && candidate.lookaheadPower !== false && (!safest || route.linkKm < safest.linkKm)) {
      safest = route;
    }
    if (!shortest || route.linkKm < shortest.linkKm) {
      shortest = route;
    }
  }
  return safest ?? shortest;
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/** One hand-off, as measured. */
interface HandoffSample {
  linkKm: number;
  legs: number;
  /** Steps the chosen target itself stays powered, from the moment of the decision. */
  dwellSeconds: number;
  /** Plane distance between host and target: 0 is a hand-off inside the same ring. */
  planeDelta: number;
  transferSeconds: number;
}

interface PolicyResult {
  policy: Policy;
  events: number;
  stranded: number;
  samples: HandoffSample[];
}

/**
 * Steps until `sat` gets power back, from `step` inclusive. `Infinity` when it does
 * not inside the flight.
 *
 * The alternative every hand-off is competing with, and the one the model never
 * costs: **do nothing and wait for the sun.** A migration is only worth its transfer
 * and its stall if the host's own dark interval is longer than the stall — and near
 * the turning latitude of an inclined orbit that is not obvious, which is why this is
 * measured rather than assumed.
 */
function stepsUntilLight(flight: Flight, sat: number, step: number): number {
  for (let at = step; at < flight.steps; at += 1) {
    if (flight.power[at]?.[sat] === true) {
      return at - step;
    }
  }
  return Infinity;
}

/** Steps until `sat` loses power, from `step` inclusive. `Infinity` when it never does. */
function stepsUntilDark(flight: Flight, sat: number, step: number): number {
  for (let at = step; at < flight.steps; at += 1) {
    if (!flight.power[at]?.[sat]) {
      return at - step;
    }
  }
  return Infinity;
}

/** The hosts at one instant, as `migration.ts` wants them. */
function hostsAt(flight: Flight, step: number, lookaheadSteps: number): MigrationHost[] {
  const future = Math.min(flight.steps - 1, step + lookaheadSteps);
  return flight.names.map((name, sat) => ({
    name,
    position: flight.positions[step]?.[sat] as MigrationHost["position"],
    hasPower: flight.power[step]?.[sat] === true,
    lookaheadPower: flight.power[future]?.[sat] === true,
  }));
}

/**
 * Every eclipse entry in the flight, and what each policy does about it.
 *
 * An "entry" is a powered→dark transition, which is the event the naive policy
 * reacts to and the event every predictive policy is trying to get ahead of. Using
 * the same event list for all four is deliberate: the policies then differ only in
 * *when* they look and *what they demand*, so the distance difference between them
 * is the price of the warning, not an artefact of counting different things.
 *
 * The first `warmup` steps are skipped so a satellite that starts the flight already
 * dark does not register a spurious entry, and the last `lookahead` steps because a
 * dwell that runs past the end of the flight cannot be measured.
 */
function measure(flight: Flight, policies: readonly Policy[]): PolicyResult[] {
  const results: PolicyResult[] = policies.map((policy) => ({ policy, events: 0, stranded: 0, samples: [] }));
  const maxLookaheadSteps = Math.ceil(Math.max(...policies.map((policy) => policy.lookaheadSeconds)) / flight.stepSeconds);

  for (let step = 1; step < flight.steps - maxLookaheadSteps; step += 1) {
    for (let sat = 0; sat < flight.names.length; sat += 1) {
      const wasPowered = flight.power[step - 1]?.[sat] === true;
      const isPowered = flight.power[step]?.[sat] === true;
      if (!wasPowered || isPowered) {
        continue;
      }
      // `step` is this satellite's first dark step: the eclipse entry.
      for (let at = 0; at < policies.length; at += 1) {
        const policy = policies[at] as Policy;
        const result = results[at] as PolicyResult;
        const lookaheadSteps = Math.round(policy.lookaheadSeconds / flight.stepSeconds);
        const trigger = step - lookaheadSteps;
        if (trigger < 0) {
          continue;
        }
        // A predictive policy only fires while the host still has power. When the
        // window reaches back past a short lit gap the trigger is not valid, and the
        // policy degrades to the reactive one — which is the truth about it, not a
        // reason to drop the event.
        const effective = lookaheadSteps > 0 && flight.power[trigger]?.[sat] !== true ? step : trigger;
        const hosts = hostsAt(flight, effective, lookaheadSteps);
        const source = hosts[sat] as MigrationHost;
        result.events += 1;
        const route = chooseRoute(source, hosts, lookaheadSteps > 0);
        if (!route) {
          result.stranded += 1;
          continue;
        }
        const targetName = route.hops[route.hops.length - 1] as string;
        const target = flight.names.indexOf(targetName);
        const dwell = stepsUntilDark(flight, target, effective);
        result.samples.push({
          linkKm: route.linkKm,
          legs: route.legsKm.length,
          dwellSeconds: dwell === Infinity ? Infinity : dwell * flight.stepSeconds,
          planeDelta: Math.abs((flight.planes[target] as number) - (flight.planes[sat] as number)),
          transferSeconds: routeTransferCost(DEFAULT_KV_GIGABYTES, ISL_GBPS, route.legsKm).totalSeconds,
        });
      }
    }
  }
  return results;
}

/**
 * How much remaining sunlight a hand-off can demand of its target, in seconds.
 *
 * The policy table above cannot answer this on its own, and reading it as if it
 * could is the trap: a longer lookahead moves *two* things at once — it decides
 * earlier, when the host is not yet at the terminator and its whole neighbourhood is
 * still lit, and it demands more of the target. The two push the distance opposite
 * ways, which is why that table is not monotonic in the window.
 *
 * So this holds the decision instant fixed and moves only the demand: at the moment
 * the host goes dark, how far is the nearest lit satellite that will *still* be lit
 * D seconds later. Monotonic by construction, and the curve a hand-off budget is
 * actually drawn from — "I need the target to survive one pipeline pass" is a
 * requirement in seconds, and this is what that costs in kilometres.
 */
const DWELL_DEMANDS = [0, 60, 180, 600, 1200, 1800] as const;

interface ReachResult {
  dwellSeconds: number;
  km: number[];
  planeDeltas: number[];
  legs: number[];
  lattice: number[];
  relayed: number;
  unreachable: number;
  events: number;
}

/**
 * The nearest satellite that has power *and* keeps it for `dwellSteps`, at the moment
 * each host loses power.
 *
 * Same two-tier rule as the policy path — a link in view beats one around the limb,
 * shortest wire within a tier — applied to a candidate set filtered by dwell rather
 * than by the app's boolean lookahead, because a boolean cannot express "for how
 * long".
 */
function measureReach(flight: Flight, demands: readonly number[], planeCount: number, slotCount: number, wrapsPlanes: boolean): ReachResult[] {
  const maxDemandSteps = Math.ceil(Math.max(...demands) / flight.stepSeconds);
  const results: ReachResult[] = demands.map((dwellSeconds) => ({ dwellSeconds, km: [], planeDeltas: [], legs: [], lattice: [], relayed: 0, unreachable: 0, events: 0 }));

  for (let step = 1; step < flight.steps - maxDemandSteps; step += 1) {
    for (let sat = 0; sat < flight.names.length; sat += 1) {
      if (flight.power[step - 1]?.[sat] !== true || flight.power[step]?.[sat] === true) {
        continue;
      }
      const hosts = hostsAt(flight, step, 0);
      const source = hosts[sat] as MigrationHost;
      // One dwell pass over the fleet, reused by every demand: the survival time of a
      // candidate does not depend on what is being asked of it.
      const survives = flight.names.map((_, candidate) => stepsUntilDark(flight, candidate, step) * flight.stepSeconds);
      for (let at = 0; at < demands.length; at += 1) {
        const demand = demands[at] as number;
        const result = results[at] as ReachResult;
        result.events += 1;
        const eligible = hosts.filter((host, candidate) => host.hasPower && (survives[candidate] as number) >= demand);
        const route = chooseRoute(source, eligible, false, hosts);
        if (!route) {
          result.unreachable += 1;
          continue;
        }
        const target = flight.names.indexOf(route.hops[route.hops.length - 1] as string);
        result.km.push(route.linkKm);
        result.planeDeltas.push(Math.abs((flight.planes[target] as number) - (flight.planes[sat] as number)));
        result.legs.push(route.legsKm.length);
        result.lattice.push(latticeHops(flight, sat, target, planeCount, slotCount, wrapsPlanes));
        if (route.legsKm.length > 1) {
          result.relayed += 1;
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Which satellite you hand to: nearest lit, or the next one round your own ring
// ---------------------------------------------------------------------------

/**
 * The target-selection rules worth comparing, and why they are not the same question
 * as the lookahead window.
 *
 * `nearest` is what `chooseTarget` does: the closest lit satellite anywhere in the
 * fleet. The measurements above show where that lands — a plane roughly 140° away in
 * right ascension, on a link that exists only in the visibility graph.
 *
 * `ring` is the other obvious rule, and the one the drawn topology can actually
 * carry: stay in your own orbital plane and hand to the next lit satellite round the
 * ring. It has a property nothing else here has — **the link never changes length**
 * (`CV ≈ 0.001`, `derive-isl-topology.ts`), so it is the one hand-off whose cost is
 * known before the pass starts.
 *
 * It also has a hard limit, and it is arithmetic rather than measurement. Every
 * satellite in a ring shares a plane, so it shares a β and a terminator: the
 * satellite k slots behind you enters eclipse exactly k·T/S seconds after you do.
 * Going round the ring therefore buys dwell in fixed quanta, and buying more means
 * reaching further — until the chord `2r·sin(kπ/S)` runs past the link horizon and
 * the ring hand-off has to be relayed round its own ring.
 *
 * `adjacent` is the third rule the lattice can carry in one hop: same slot, next
 * plane over. Included because it is what an ISL topology already wired for routing
 * would reach for first, and it is worth knowing what it costs in dwell.
 */
type TargetRule = "nearest" | "ring" | "ring-far" | "adjacent" | "fresh" | "ring-fresh";

const TARGET_RULES: ReadonlyArray<{ rule: TargetRule; label: string }> = [
  { rule: "nearest", label: "nearest lit, any plane" },
  { rule: "ring", label: "same plane, next lit slot" },
  { rule: "ring-far", label: "same plane, furthest lit slot in view" },
  { rule: "adjacent", label: "adjacent plane only" },
  { rule: "fresh", label: "freshest sunlit, anywhere reachable" },
  { rule: "ring-fresh", label: "freshest sunlit in own ring" },
];

/**
 * The route a rule picks, which is not always the shortest one.
 *
 * Every rule here except `ring-far` prefers the shortest wire, because that is what
 * `chooseTarget` does and what a transfer is charged for. `ring-far` deliberately
 * does the opposite: **inside a ring, distance and dwell are the same quantity.**
 * Every satellite in the ring shares a terminator, so the one k slots back is both
 * `2r·sin(kπ/S)` away and `k·T/S` seconds later into the shadow — and hopping to the
 * nearest one buys the *least* possible dwell, which is a treadmill. Reaching as far
 * back as the link horizon allows is the same hand-off done once instead of k times.
 *
 * It is the only rule here that spends distance on purpose, and the ring is the only
 * place where doing so is a clean trade rather than a gamble, because the
 * relationship is exact.
 */
function selectRoute(
  flight: Flight,
  step: number,
  source: MigrationHost,
  candidates: readonly MigrationHost[],
  pool: readonly MigrationHost[],
  rule: TargetRule,
): MigrationRoute | undefined {
  if (rule === "fresh" || rule === "ring-fresh") {
    // Residence, not distance: take the satellite with the most sunlit arc left, over
    // every target a chain of lit relays can reach. Relays are allowed here where
    // `ring-far` refuses them, because the whole point of the rule is that the freshest
    // satellite is *not* in view — it is most of a dark arc away round the orbit.
    const routes = routesFrom(source, pool.some((host) => host.name === source.name) ? pool : [...pool, source]);
    let best: MigrationRoute | undefined;
    let bestDwell = -1;
    for (const candidate of candidates) {
      const route = routes.get(candidate.name);
      if (!route) {
        continue;
      }
      const dwell = stepsUntilDark(flight, flight.names.indexOf(candidate.name), step);
      // Ties on dwell go to the shorter wire, so the rule is deterministic and does not
      // wander between equally fresh targets.
      if (dwell > bestDwell || (dwell === bestDwell && best !== undefined && route.linkKm < best.linkKm)) {
        bestDwell = dwell;
        best = route;
      }
    }
    return best;
  }
  if (rule !== "ring-far") {
    return chooseRoute(source, candidates, false, pool);
  }
  let best: MigrationRoute | undefined;
  let bestDwell = -1;
  for (const candidate of candidates) {
    if (candidate.name === source.name || !hasLineOfSight(source.position, candidate.position)) {
      continue;
    }
    const dwell = stepsUntilDark(flight, flight.names.indexOf(candidate.name), step);
    if (dwell > bestDwell) {
      bestDwell = dwell;
      const km = distanceKm(source.position, candidate.position);
      best = { hops: [source.name, candidate.name], legsKm: [km], linkKm: km };
    }
  }
  // Nothing in view round the ring: fall back to the shortest relayed path, same as
  // every other rule, rather than reporting a reachable hand-off as impossible.
  return best ?? chooseRoute(source, candidates, false, pool);
}

/** Whether `candidate` is eligible under `rule`, given the host it is replacing. */
function eligibleUnder(flight: Flight, rule: TargetRule, host: number, candidate: number, planeCount: number, wrapsPlanes: boolean): boolean {
  if (rule === "nearest") {
    return true;
  }
  const hostPlane = flight.planes[host] as number;
  const candidatePlane = flight.planes[candidate] as number;
  if (rule === "ring" || rule === "ring-far" || rule === "ring-fresh") {
    return hostPlane === candidatePlane;
  }
  const gap = Math.abs(candidatePlane - hostPlane);
  return (wrapsPlanes ? Math.min(gap, planeCount - gap) : gap) === 1;
}

/**
 * How many slots round the ring a hand-off can reach before the Earth stops it, and
 * what that is worth in dwell.
 *
 * Closed form, checked against the measurement: the chord to the satellite k slots
 * away is `2r·sin(kπ/S)`, the link horizon is `2√(r² − (Rₑ+margin)²)`, and each slot
 * is `T/S` seconds of the orbit. So the ring hand-off's reachable dwell is bounded by
 * the *geometry of the ring*, not by the eclipse — and a ring dense enough to keep
 * its links short is also a ring whose neighbours go dark right after it does.
 */
function ringReach(params: WalkerDeltaParams): { slots: number; chordKm: number; dwellSeconds: number; slotSeconds: number } {
  const radiusKm = 6378.135 + params.altitudeKm;
  const perPlane = satsPerPlane(params);
  const slotSeconds = periodSeconds(params.altitudeKm) / perPlane;
  const horizon = horizonKm(params.altitudeKm);
  let slots = 0;
  for (let k = 1; k <= Math.floor(perPlane / 2); k += 1) {
    if (2 * radiusKm * Math.sin((k * Math.PI) / perPlane) > horizon) {
      break;
    }
    slots = k;
  }
  return { slots, chordKm: 2 * radiusKm * Math.sin((slots * Math.PI) / perPlane), dwellSeconds: slots * slotSeconds, slotSeconds };
}

interface RuleResult {
  rule: TargetRule;
  label: string;
  km: number[];
  dwell: number[];
  legs: number[];
  lattice: number[];
  /** |latitude| of the target when it was chosen. */
  targetLatitude: number[];
  unreachable: number;
  events: number;
}

/** Each rule's hand-off, measured on the same eclipse entries. */
function measureRules(flight: Flight, planeCount: number, slotCount: number, wrapsPlanes: boolean): RuleResult[] {
  const results: RuleResult[] = TARGET_RULES.map(({ rule, label }) => ({ rule, label, km: [], dwell: [], legs: [], lattice: [], targetLatitude: [], unreachable: 0, events: 0 }));
  for (let step = 1; step < flight.steps; step += 1) {
    for (let sat = 0; sat < flight.names.length; sat += 1) {
      if (flight.power[step - 1]?.[sat] !== true || flight.power[step]?.[sat] === true) {
        continue;
      }
      const hosts = hostsAt(flight, step, 0);
      const source = hosts[sat] as MigrationHost;
      for (const result of results) {
        result.events += 1;
        const candidates = hosts.filter((host, candidate) => host.hasPower && eligibleUnder(flight, result.rule, sat, candidate, planeCount, wrapsPlanes));
        // The relay pool is the rule's own fabric. A ring hand-off that cannot reach
        // its target directly relays *round its own ring* — which is the whole point
        // of the rule, since those links already exist and never change length. Letting
        // it borrow another plane's satellites would be measuring a different rule.
        const pool = result.rule.startsWith("ring") ? hosts.filter((_, candidate) => eligibleUnder(flight, "ring", sat, candidate, planeCount, wrapsPlanes)) : hosts;
        const route = selectRoute(flight, step, source, candidates, pool, result.rule);
        if (!route) {
          result.unreachable += 1;
          continue;
        }
        const target = flight.names.indexOf(route.hops[route.hops.length - 1] as string);
        result.km.push(route.linkKm);
        result.dwell.push(stepsUntilDark(flight, target, step) * flight.stepSeconds);
        result.legs.push(route.legsKm.length);
        result.lattice.push(latticeHops(flight, sat, target, planeCount, slotCount, wrapsPlanes));
        result.targetLatitude.push(Math.abs(flight.latitude[step]?.[target] as number));
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// The whole fleet migrates, not one workload
// ---------------------------------------------------------------------------

/**
 * What one workload actually does over an orbit, followed hop by hop.
 *
 * Everything above measures single decisions. This measures the *consequence*: a
 * workload is placed on a satellite and followed, migrating whenever its policy says
 * to, for the whole flight. That is what turns "the median target is dark 140 s
 * later" into a migration count — and a migration count is what a bandwidth figure
 * needs, because the fleet does not migrate once, it migrates continuously.
 *
 * No contention, matching the model it is measuring: every workload is followed
 * independently, so two of them may choose the same target and neither is charged
 * for the other. `measureHotspots` says how wrong that is.
 */
interface ChainResult {
  label: string;
  migrations: number;
  workloads: number;
  km: number[];
  legs: number[];
  /** Seconds of power the workload actually held after each migration: the arc it bought. */
  bought: number[];
  darkSteps: number;
  totalSteps: number;
  stranded: number;
}

function followChains(flight: Flight, label: string, rule: TargetRule, lookaheadSeconds: number, planeCount: number, wrapsPlanes: boolean, sampleEvery: number): ChainResult {
  const lookaheadSteps = Math.round(lookaheadSeconds / flight.stepSeconds);
  const result: ChainResult = { label, migrations: 0, workloads: 0, km: [], legs: [], bought: [], darkSteps: 0, totalSteps: 0, stranded: 0 };
  for (let start = 0; start < flight.names.length; start += sampleEvery) {
    let host = start;
    result.workloads += 1;
    for (let step = 0; step < flight.steps - lookaheadSteps; step += 1) {
      result.totalSteps += 1;
      const powered = flight.power[step]?.[host] === true;
      if (!powered) {
        result.darkSteps += 1;
      }
      // Predictive fires before the power goes *and* still reacts once it has —
      // `decideStageMigration` falls through to the reactive branch when the host is
      // already dark, and a chain that did not would simply sit in the shadow.
      const aboutToGoDark = lookaheadSteps > 0 && powered && flight.power[step + lookaheadSteps]?.[host] !== true;
      if (!aboutToGoDark && powered) {
        continue;
      }
      const hosts = hostsAt(flight, step, lookaheadSteps);
      const source = hosts[host] as MigrationHost;
      const lit = hosts.filter((candidate, index) => index !== host && candidate.hasPower && eligibleUnder(flight, rule, host, index, planeCount, wrapsPlanes));
      // Lookahead-safety is a *preference*, not a filter — the app expresses it as the
      // top two tiers of `chooseRouteExcluding`, which fall through to any lit target
      // rather than declaring the stage stranded. Filtering on it instead was what left
      // predictive chains sitting dark.
      const safe = lookaheadSteps === 0 ? lit : lit.filter((candidate) => flight.power[step + lookaheadSteps]?.[flight.names.indexOf(candidate.name)] === true);
      const candidates = safe.length > 0 ? safe : lit;
      const pool = rule.startsWith("ring") ? hosts.filter((_, index) => eligibleUnder(flight, "ring", host, index, planeCount, wrapsPlanes)) : hosts;
      const route = selectRoute(flight, step, source, candidates, pool, rule);
      if (!route) {
        result.stranded += 1;
        continue;
      }
      host = flight.names.indexOf(route.hops[route.hops.length - 1] as string);
      result.migrations += 1;
      // What this migration actually bought, which is the only honest way to check the
      // arithmetic: migrations per orbit should be the orbit divided by this.
      result.bought.push(stepsUntilDark(flight, host, step) * flight.stepSeconds);
      result.km.push(route.linkKm);
      result.legs.push(route.legsKm.length);
    }
  }
  return result;
}

/**
 * How many workloads would pick the *same* satellite at the same instant.
 *
 * The single-workload model cannot see this and the pipeline model only avoids it
 * inside one pipeline (`taken`). But a fleet that computes everywhere has a workload
 * on every satellite, and they all cross the terminator on their own schedule — so
 * "nearest lit" is a rule every dark satellite applies at once, to a lit set that is
 * the same for all of them. Where they converge is a receiver that has to serialise
 * several caches in a row, and that is the first place a bandwidth figure stops being
 * per-link and starts being per-node.
 */
function measureHotspots(flight: Flight, rule: TargetRule, planeCount: number, wrapsPlanes: boolean): { peak: number; mean: number; busiestStep: number } {
  let peak = 0;
  let sum = 0;
  let samples = 0;
  let busiestStep = 0;
  for (let step = 1; step < flight.steps; step += 1) {
    const entering: number[] = [];
    for (let sat = 0; sat < flight.names.length; sat += 1) {
      if (flight.power[step - 1]?.[sat] === true && flight.power[step]?.[sat] !== true) {
        entering.push(sat);
      }
    }
    if (entering.length === 0) {
      continue;
    }
    const hosts = hostsAt(flight, step, 0);
    const inbound = new Map<string, number>();
    for (const sat of entering) {
      const candidates = hosts.filter((host, candidate) => host.hasPower && eligibleUnder(flight, rule, sat, candidate, planeCount, wrapsPlanes));
      const route = selectRoute(flight, step, hosts[sat] as MigrationHost, candidates, hosts, rule);
      if (!route) {
        continue;
      }
      const target = route.hops[route.hops.length - 1] as string;
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
    for (const count of inbound.values()) {
      if (count > peak) {
        peak = count;
        busiestStep = step;
      }
    }
    sum += entering.length;
    samples += 1;
  }
  return { peak, mean: samples === 0 ? 0 : sum / samples, busiestStep };
}

/**
 * The two arcs themselves: how long a satellite holds power, and how long it loses it.
 *
 * The quantity every policy above is implicitly spending, and the one that was missing.
 * A hand-off does not buy "distance", it buys **residence** — the target's remaining
 * lit arc — and the ceiling on that is the lit arc itself. So the best any policy can
 * do is land on a satellite at the *start* of its sunlit arc, which makes the floor on
 * the migration rate `T / lit arc` and not zero.
 *
 * Runs that touch either end of the flight are dropped: a lit run still going when the
 * window closes is not a measurement of a lit run, it is a measurement of the window.
 */
function residenceArcs(flight: Flight): { lit: number[]; dark: number[]; litByPlane: Map<number, number[]> } {
  const lit: number[] = [];
  const dark: number[] = [];
  const litByPlane = new Map<number, number[]>();
  for (let sat = 0; sat < flight.names.length; sat += 1) {
    let runStart = 0;
    let runState = flight.power[0]?.[sat] === true;
    for (let step = 1; step <= flight.steps; step += 1) {
      const state = step < flight.steps ? flight.power[step]?.[sat] === true : !runState;
      if (state === runState) {
        continue;
      }
      // Interior runs only — one that started at step 0 or is still open at the end is
      // truncated by the window rather than by the orbit.
      if (runStart > 0 && step < flight.steps) {
        const seconds = (step - runStart) * flight.stepSeconds;
        (runState ? lit : dark).push(seconds);
        if (runState) {
          const plane = flight.planes[sat] as number;
          litByPlane.set(plane, [...(litByPlane.get(plane) ?? []), seconds]);
        }
      }
      runStart = step;
      runState = state;
    }
  }
  return { lit, dark, litByPlane };
}

/**
 * The nearest other satellite, powered or not, at a sample of instants: the pattern's
 * own local spacing, and the floor no policy can beat.
 *
 * Without it a distance figure has no scale — 600 km is a long hop in a dense shell
 * and an impossibly short one in a sparse pattern, and only this says which.
 */
function nearestNeighbourKm(flight: Flight, sampleSteps: number): number[] {
  const lengths: number[] = [];
  const stride = Math.max(1, Math.floor(flight.steps / sampleSteps));
  for (let step = 0; step < flight.steps; step += stride) {
    const frame = flight.positions[step];
    if (!frame) {
      continue;
    }
    for (let sat = 0; sat < frame.length; sat += 1) {
      let best = Infinity;
      for (let other = 0; other < frame.length; other += 1) {
        if (other === sat) {
          continue;
        }
        const km = distanceKm(frame[sat] as MigrationHost["position"], frame[other] as MigrationHost["position"]);
        if (km < best) {
          best = km;
        }
      }
      lengths.push(best);
    }
  }
  return lengths;
}

/**
 * What fraction of all (satellite, step) pairs were dark, and eclipsed — and how
 * many satellites were never dark at all.
 *
 * The last one is not decoration. A pattern with a permanently-lit population has a
 * standing answer to "where does this workload go", and the whole dwell curve
 * collapses onto it: the nearest never-dark satellite is the target at every demand.
 * Without this column that shows up as a suspiciously flat table.
 */
function darkFractions(flight: Flight): { dark: number; eclipse: number; neverDark: number; planesNeverDark: number } {
  let dark = 0;
  let eclipse = 0;
  let total = 0;
  for (let step = 0; step < flight.steps; step += 1) {
    for (let sat = 0; sat < flight.names.length; sat += 1) {
      total += 1;
      if (flight.power[step]?.[sat] !== true) {
        dark += 1;
      }
      if (flight.eclipsed[step]?.[sat] === true) {
        eclipse += 1;
      }
    }
  }
  let neverDark = 0;
  const litPlanes = new Set<number>();
  for (let sat = 0; sat < flight.names.length; sat += 1) {
    let dim = false;
    for (let step = 0; step < flight.steps && !dim; step += 1) {
      dim = flight.power[step]?.[sat] !== true;
    }
    if (!dim) {
      neverDark += 1;
      litPlanes.add(flight.planes[sat] as number);
    }
  }
  return { dark: dark / total, eclipse: eclipse / total, neverDark: neverDark / flight.names.length, planesNeverDark: litPlanes.size };
}

/**
 * Assert the fast path agrees with `chooseRouteExcluding` on a sample of real
 * instants, so the numbers below are the app's policy and not this file's reading
 * of it.
 */
function checkAgainstApp(flight: Flight, samples: number): string {
  let checked = 0;
  let mismatched = 0;
  const stride = Math.max(1, Math.floor(flight.steps / samples));
  for (let step = 0; step < flight.steps; step += stride) {
    const hosts = hostsAt(flight, step, Math.round(90 / flight.stepSeconds));
    for (const preferLookahead of [false, true]) {
      for (let sat = 0; sat < flight.names.length; sat += Math.ceil(flight.names.length / 8)) {
        const source = hosts[sat] as MigrationHost;
        const mine = chooseRoute(source, hosts, preferLookahead);
        const theirs = chooseRouteExcluding(source, hosts, new Set(), preferLookahead)?.route;
        checked += 1;
        if ((mine?.hops.join(">") ?? "-") !== (theirs?.hops.join(">") ?? "-")) {
          mismatched += 1;
        }
      }
    }
  }
  return mismatched === 0 ? `fast path agrees with chooseRouteExcluding on ${checked} decisions` : `MISMATCH: ${mismatched}/${checked} decisions differ from chooseRouteExcluding`;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function percentile(values: readonly number[], fraction: number): number {
  const finite = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (finite.length === 0) {
    return Number.NaN;
  }
  const index = Math.min(finite.length - 1, Math.max(0, Math.round(fraction * (finite.length - 1))));
  return finite[index] as number;
}

function maxOf(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length === 0 ? Number.NaN : Math.max(...finite);
}

function fixed(value: number, digits = 0): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

/** The in-plane chord between adjacent slots: the closed form the measurements land on. */
function ringChordKm(params: WalkerDeltaParams): number {
  const radiusKm = 6378.135 + params.altitudeKm;
  return 2 * radiusKm * Math.sin(Math.PI / satsPerPlane(params));
}

/** The longest link the Earth allows between two satellites at this altitude. */
function horizonKm(altitudeKm: number): number {
  const radiusKm = 6378.135 + altitudeKm;
  const blocking = EARTH_RADIUS_KM + LINK_MARGIN_KM;
  return 2 * Math.sqrt(Math.max(0, radiusKm * radiusKm - blocking * blocking));
}

interface RunOptions {
  epoch: Date;
  orbits: number;
  stepSeconds: number;
  model: PowerModel;
}

function reportPattern(label: string, params: WalkerDeltaParams, options: RunOptions, verify = false): void {
  const flight = fly(params, options.epoch, options.orbits, options.stepSeconds, options.model);
  const fractions = darkFractions(flight);
  const spacing = nearestNeighbourKm(flight, 12);
  const results = measure(flight, POLICIES);

  console.log(`\n### ${label} — ${encodeWalker(params)}  (${params.planes} planes × ${satsPerPlane(params)})`);
  console.log(
    `power model: ${options.model} · dark ${(fractions.dark * 100).toFixed(1)}% · eclipsed ${(fractions.eclipse * 100).toFixed(1)}% · ` +
      `never dark ${(fractions.neverDark * 100).toFixed(0)}% (${fractions.planesNeverDark}/${params.planes} planes) · ` +
      `nearest neighbour p50 ${fixed(percentile(spacing, 0.5))} km · ring chord ${fixed(ringChordKm(params))} km · link horizon ${fixed(horizonKm(params.altitudeKm))} km`,
  );
  if (verify) {
    console.log(`check: ${checkAgainstApp(flight, 6)}`);
  }
  console.log("");
  console.log("| policy | events | hand-off km p50 | p90 | max | relayed | same plane | target dwell p50 | dark < 60 s | 2 GB transfer p50 | stranded |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const result of results) {
    const km = result.samples.map((sample) => sample.linkKm);
    const relayed = result.samples.filter((sample) => sample.legs > 1).length;
    const samePlane = result.samples.filter((sample) => sample.planeDelta === 0).length;
    const dwell = result.samples.map((sample) => sample.dwellSeconds);
    const transfer = result.samples.map((sample) => sample.transferSeconds);
    const churn = result.samples.filter((sample) => sample.dwellSeconds < 60).length;
    const share = (count: number): string => (result.samples.length === 0 ? "—" : `${((100 * count) / result.samples.length).toFixed(0)}%`);
    console.log(
      `| ${result.policy.label} | ${result.events} | ${fixed(percentile(km, 0.5))} | ${fixed(percentile(km, 0.9))} | ${fixed(maxOf(km))} | ` +
        `${share(relayed)} | ${share(samePlane)} | ${fixed(percentile(dwell, 0.5))} s | ${share(churn)} | ${fixed(percentile(transfer, 0.5), 3)} s | ` +
        `${result.events === 0 ? "—" : `${((100 * result.stranded) / result.events).toFixed(1)}%`} |`,
    );
  }

  console.log("");
  console.log("Reach at the eclipse-entry instant, by how much remaining sunlight the target must have:");
  console.log("");
  console.log("| target must stay lit | nearest such km p50 | p90 | max | relayed | legs p50 | median Δplane | 2 GB transfer p50 | over fixed ISL lattice | none reachable |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const reach of measureReach(flight, DWELL_DEMANDS, params.planes, satsPerPlane(params), params.raanSpanDeg === 360)) {
    // Store-and-forward: one serialisation per leg, so the transfer is priced on the
    // median wire split across the median leg count, not on the wire alone.
    const legs = percentile(reach.legs, 0.5);
    const wire = percentile(reach.km, 0.5);
    const transfer = Number.isFinite(legs)
      ? routeTransferCost(
          DEFAULT_KV_GIGABYTES,
          ISL_GBPS,
          Array.from({ length: legs }, () => wire / legs),
        ).totalSeconds
      : Number.NaN;
    console.log(
      `| ≥ ${reach.dwellSeconds} s | ${fixed(wire)} | ${fixed(percentile(reach.km, 0.9))} | ${fixed(maxOf(reach.km))} | ` +
        `${reach.km.length === 0 ? "—" : `${((100 * reach.relayed) / reach.km.length).toFixed(0)}%`} | ${fixed(legs)} | ${fixed(percentile(reach.planeDeltas, 0.5))} | ` +
        `${fixed(transfer, 3)} s | ${fixed(percentile(reach.lattice, 0.5))} hops, ${fixed((percentile(reach.lattice, 0.5) * 8 * DEFAULT_KV_GIGABYTES) / ISL_GBPS, 2)} s | ` +
        `${reach.events === 0 ? "—" : `${((100 * reach.unreachable) / reach.events).toFixed(1)}%`} |`,
    );
  }

  reportRules(flight, params);
}

/**
 * Where the hand-off goes under each target rule, and what waiting instead would
 * have cost.
 */
function reportRules(flight: Flight, params: WalkerDeltaParams): void {
  const wrapsPlanes = params.raanSpanDeg === 360;
  const ring = ringReach(params);
  const perPlane = satsPerPlane(params);

  // The alternative the hand-off is competing with, measured on the same entries.
  const waits: number[] = [];
  const entryLatitudes: number[] = [];
  for (let step = 1; step < flight.steps; step += 1) {
    for (let sat = 0; sat < flight.names.length; sat += 1) {
      if (flight.power[step - 1]?.[sat] === true && flight.power[step]?.[sat] !== true) {
        waits.push(stepsUntilLight(flight, sat, step) * flight.stepSeconds);
        entryLatitudes.push(Math.abs(flight.latitude[step]?.[sat] as number));
      }
    }
  }

  const arcs = residenceArcs(flight);
  const period = periodSeconds(params.altitudeKm);
  const litP50 = percentile(arcs.lit, 0.5);
  const planeMedians = [...arcs.litByPlane.entries()].map(([plane, runs]) => ({ plane, median: percentile(runs, 0.5) }));
  console.log("");
  console.log(
    `Residence: sunlit arc p50 ${fixed(litP50)} s (p10 ${fixed(percentile(arcs.lit, 0.1))}, p90 ${fixed(percentile(arcs.lit, 0.9))}), ` +
      `dark arc p50 ${fixed(percentile(arcs.dark, 0.5))} s, over a ${fixed(period)} s orbit. ` +
      `Across planes the sunlit arc runs ${fixed(Math.min(...planeMedians.map((entry) => entry.median)))}–${fixed(Math.max(...planeMedians.map((entry) => entry.median)))} s.`,
  );
  console.log(
    `So a workload that always landed at the *start* of a sunlit arc would migrate ${(period / litP50).toFixed(2)} times per orbit. ` +
      `That is the floor; every rule below is measured against it.`,
  );
  console.log("");
  console.log(
    `Ring arithmetic: ${perPlane} slots × ${fixed(ring.slotSeconds)} s each; a direct ring hop reaches ${ring.slots} slot(s) ` +
      `(${fixed(ring.chordKm)} km ≤ ${fixed(horizonKm(params.altitudeKm))} km horizon) = ${fixed(ring.dwellSeconds)} s of dwell. Beyond that it relays round its own ring.`,
  );
  console.log(
    `Host goes dark at |lat| p50 ${fixed(percentile(entryLatitudes, 0.5))}° and is back in sunlight after p50 ${fixed(percentile(waits, 0.5))} s (p10 ${fixed(percentile(waits, 0.1))} s).`,
  );
  console.log("");
  console.log("| target rule | hand-off km p50 | legs p50 | lattice hops p50 | target dwell p50 | target \\|lat\\| p50 | unreachable |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const result of measureRules(flight, params.planes, perPlane, wrapsPlanes)) {
    console.log(
      `| ${result.label} | ${fixed(percentile(result.km, 0.5))} | ${fixed(percentile(result.legs, 0.5))} | ${fixed(percentile(result.lattice, 0.5))} | ` +
        `${fixed(percentile(result.dwell, 0.5))} s | ${fixed(percentile(result.targetLatitude, 0.5))}° | ` +
        `${result.events === 0 ? "—" : `${((100 * result.unreachable) / result.events).toFixed(1)}%`} |`,
    );
  }
}

/**
 * What the fleet, rather than one workload, is doing — and whether the link can carry
 * it.
 *
 * One workload per satellite is the premise of the whole fork: a constellation that
 * computes everywhere. Every one of those satellites loses power once a revolution,
 * so the migration rate is not a property of a demo, it is `N / T` before any churn
 * is added. This prices that.
 */
function reportLoad(label: string, params: WalkerDeltaParams, options: RunOptions): void {
  const flight = fly(params, options.epoch, options.orbits, options.stepSeconds, options.model);
  const wrapsPlanes = params.raanSpanDeg === 360;
  const period = periodSeconds(params.altitudeKm);
  const sampleEvery = Math.max(1, Math.round(params.total / 24));

  console.log(`\n### ${label} — ${encodeWalker(params)}`);
  console.log(`Following ${Math.ceil(params.total / sampleEvery)} workloads for ${options.orbits} revolutions, one policy at a time.`);
  console.log("");
  console.log(
    "| policy | migrations per workload per orbit | arc bought per migration | per leg | hop km p50 | legs p50 | KV moved per workload per orbit | dark at 5 s cadence | fleet ISL duty |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

  const chains: Array<{ label: string; rule: TargetRule; lookahead: number }> = [
    { label: "naive, nearest lit", rule: "nearest", lookahead: 0 },
    { label: "naive, next lit slot in ring", rule: "ring", lookahead: 0 },
    { label: "naive, furthest lit slot in ring", rule: "ring-far", lookahead: 0 },
    { label: "naive, freshest sunlit anywhere", rule: "fresh", lookahead: 0 },
    { label: "naive, freshest sunlit in own ring", rule: "ring-fresh", lookahead: 0 },
    { label: "predictive 90 s, nearest lit", rule: "nearest", lookahead: 90 },
    { label: "predictive 90 s, furthest lit slot in ring", rule: "ring-far", lookahead: 90 },
    { label: "predictive 90 s, freshest sunlit anywhere", rule: "fresh", lookahead: 90 },
  ];
  for (const spec of chains) {
    const chain = followChains(flight, spec.label, spec.rule, spec.lookahead, params.planes, wrapsPlanes, sampleEvery);
    const orbitsFlown = (chain.totalSteps * flight.stepSeconds) / period;
    const perWorkloadPerOrbit = chain.migrations / (orbitsFlown || 1);
    const legs = percentile(chain.legs, 0.5);
    const gbPerOrbit = perWorkloadPerOrbit * DEFAULT_KV_GIGABYTES * (Number.isFinite(legs) ? legs : 1);
    // One ISL-second is one link busy for one second. A leg occupies one for the
    // serialisation time, so the fleet's duty cycle is link-seconds demanded over
    // link-seconds available — one ISL per satellite.
    const dutyCycle = (perWorkloadPerOrbit * (Number.isFinite(legs) ? legs : 1) * ((DEFAULT_KV_GIGABYTES * 8) / ISL_GBPS)) / period;
    // A reactive policy notices it is dark only when it next looks, so its downtime is
    // migrations × evaluation cadence and nothing to do with the geometry. Quoting the
    // measured figure alone would be quoting this script's step size; the second column
    // rescales it to MIGRATION_EVAL_SIM_SECONDS, which is what the app actually runs.
    const darkAtAppCadence = spec.lookahead > 0 ? (100 * chain.darkSteps) / chain.totalSteps : (100 * perWorkloadPerOrbit * 5) / period;
    const perMigration = Number.isFinite(legs)
      ? routeTransferCost(
          DEFAULT_KV_GIGABYTES,
          ISL_GBPS,
          Array.from({ length: legs }, () => percentile(chain.km, 0.5) / legs),
        ).totalSeconds
      : Number.NaN;
    void perMigration;
    // Degrees of orbital arc, because that is the unit the geometry is actually in: a
    // migration buys phase against a terminator that is fixed in inertial space, and
    // the link horizon caps how much phase one leg can span.
    const boughtSeconds = percentile(chain.bought, 0.5);
    const boughtDeg = (360 * boughtSeconds) / period;
    const perLegDeg = Number.isFinite(legs) && legs > 0 ? boughtDeg / legs : Number.NaN;
    console.log(
      `| ${spec.label} | ${perWorkloadPerOrbit.toFixed(1)} | ${fixed(boughtSeconds)} s = ${fixed(boughtDeg)}° | ${fixed(perLegDeg)}°/leg | ` +
        `${fixed(percentile(chain.km, 0.5))} | ${fixed(legs)} | ${gbPerOrbit.toFixed(1)} GB | ` +
        `${darkAtAppCadence.toFixed(1)}% | ${(100 * dutyCycle).toFixed(3)}% |`,
    );
  }

  console.log("");
  for (const rule of ["nearest", "ring-far"] as TargetRule[]) {
    const hotspot = measureHotspots(flight, rule, params.planes, wrapsPlanes);
    console.log(
      `Convergence, ${rule}: ${hotspot.mean.toFixed(1)} satellites enter eclipse per ${flight.stepSeconds} s step fleet-wide; ` +
        `the busiest receiver is chosen by **${hotspot.peak}** of them at once.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The sweeps
// ---------------------------------------------------------------------------

const BASE: WalkerDeltaParams = { total: 220, planes: 10, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };

/** March equinox: the date at which a 53° shell's planes span the widest range of β. */
const EQUINOX = new Date("2026-03-20T12:00:00.000Z");

function withOverrides(overrides: Partial<WalkerDeltaParams>): WalkerDeltaParams {
  return { ...BASE, ...overrides };
}

const SWEEPS: Record<string, Array<{ label: string; params: WalkerDeltaParams }>> = {
  base: [{ label: "base", params: BASE }],
  perplane: [
    { label: "S = 11 per plane", params: withOverrides({ total: 110 }) },
    { label: "S = 22 per plane", params: BASE },
    { label: "S = 44 per plane", params: withOverrides({ total: 440 }) },
  ],
  planes: [
    { label: "P = 5 planes", params: withOverrides({ total: 110, planes: 5 }) },
    { label: "P = 10 planes", params: BASE },
    { label: "P = 20 planes", params: withOverrides({ total: 440, planes: 20 }) },
  ],
  altitude: [
    { label: "h = 350 km", params: withOverrides({ altitudeKm: 350 }) },
    { label: "h = 550 km", params: BASE },
    { label: "h = 1200 km", params: withOverrides({ altitudeKm: 1200 }) },
  ],
  inclination: [
    { label: "i = 53°", params: BASE },
    { label: "i = 70°", params: withOverrides({ inclinationDeg: 70 }) },
    { label: "i = 97.6° (quasi-SSO)", params: withOverrides({ inclinationDeg: 97.6 }) },
  ],
  phasing: [
    { label: "F = 0 (abreast)", params: withOverrides({ phasing: 0 }) },
    { label: "F = 1", params: BASE },
    { label: "F = 5", params: withOverrides({ phasing: 5 }) },
  ],
  span: [
    { label: "Delta, 360° span", params: withOverrides({ inclinationDeg: 87.9 }) },
    { label: "Star, 180° span", params: withOverrides({ inclinationDeg: 87.9, raanSpanDeg: 180 }) },
  ],
  shape: [
    { label: "few planes, long rings 5 × 44", params: withOverrides({ total: 220, planes: 5 }) },
    { label: "square 10 × 22", params: BASE },
    { label: "many planes, short rings 20 × 11", params: withOverrides({ total: 220, planes: 20 }) },
  ],
};

function usage(): void {
  console.log("usage: migration-reach.ts [base|perplane|planes|altitude|inclination|phasing|span|shape|power|season|load|all]");
}

function main(): void {
  const options: RunOptions = { epoch: EQUINOX, orbits: 3, stepSeconds: 20, model: "panel" };
  const which = process.argv[2] ?? "all";

  console.log("# How far is the nearest satellite that still has power?");
  console.log("");
  console.log(`SGP4 over ${options.orbits} revolutions at ${options.stepSeconds} s steps, from ${options.epoch.toISOString()}.`);
  console.log(`Zenith panel model; KV ${DEFAULT_KV_GIGABYTES} GB over ${ISL_GBPS} Gbps, store-and-forward per leg.`);

  if (which === "power") {
    for (const model of ["panel", "eclipse"] as PowerModel[]) {
      reportPattern(`power model ${model}`, BASE, { ...options, model }, model === "panel");
    }
    return;
  }
  if (which === "load") {
    for (const [label, params] of [
      ["base 10 × 22", BASE],
      ["long rings 5 × 44", withOverrides({ total: 220, planes: 5 })],
      ["short rings 20 × 11", withOverrides({ total: 220, planes: 20 })],
      ["quasi-SSO 97.6°", withOverrides({ inclinationDeg: 97.6 })],
    ] as Array<[string, WalkerDeltaParams]>) {
      // 5 s is MIGRATION_EVAL_SIM_SECONDS: at a coarser step the reactive policies'
      // downtime is the step size rather than the policy. Two revolutions keeps that
      // affordable.
      reportLoad(label, params, { ...options, orbits: 2, stepSeconds: 5 });
    }
    return;
  }
  if (which === "season") {
    for (const iso of ["2026-03-20T12:00:00.000Z", "2026-06-21T12:00:00.000Z", "2026-09-22T12:00:00.000Z", "2026-12-21T12:00:00.000Z"]) {
      reportPattern(iso.slice(0, 10), BASE, { ...options, epoch: new Date(iso) });
    }
    return;
  }

  const sweeps = which === "all" ? Object.entries(SWEEPS) : SWEEPS[which] ? [[which, SWEEPS[which]] as const] : undefined;
  if (!sweeps) {
    usage();
    process.exitCode = 1;
    return;
  }
  let first = true;
  for (const [name, cases] of sweeps) {
    console.log(`\n## sweep: ${name}`);
    for (const { label, params } of cases as Array<{ label: string; params: WalkerDeltaParams }>) {
      reportPattern(label, params, options, first);
      first = false;
    }
  }
}

main();

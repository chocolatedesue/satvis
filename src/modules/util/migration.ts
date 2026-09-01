// A naive KV-cache live-migration model, free of Cesium and of satellite.js for
// the same reason src/modules/util/illumination.ts is: the physics answers a
// question (where should this pipeline stage's KV cache live, and what does moving
// it cost), the globe draws by that answer (src/modules/MigrationLayer.ts), and
// the panel reads it out — and none of the three should own the arithmetic.
//
// "Naive" is a deliberate scope, matching what LAB-47 asked for as its baseline: a
// pipeline stage holds a KV cache on one satellite; the moment that host stops
// being able to power its compute (it enters the Earth's shadow, or its panel turns
// away from the sun — the `sunlit_back` state this whole fork exists to name), the
// stage is live-migrated to the nearest satellite that still has power, over one
// inter-satellite link. No handshake overlap, no incremental KV patching, no
// multi-hop routing, no contention for the link — those are the improvements the
// algorithm line (LAB-47/70) is for. This is the floor they improve on, and the
// thing the visual makes watchable.
//
// The module has two layers. The first answers the single-workload question
// (`decideMigration` and the geometry it needs). The second, below it, is the
// pipeline: several stages at once, one per satellite, where the pipeline serves
// only while every stage has power — that conjunction, not any one stage, is what
// makes the naive policy expensive.
//
// The unit here is metres and seconds, and the only frame assumption is that the
// two positions handed to `distanceKm` are in the *same* frame — the caller reads
// both from the same trajectory sampler at the same instant, so a fixed-frame pair
// and an inertial-frame pair both give the true chord between the satellites.

/** A position in whatever frame the caller is working in, in metres. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A satellite that could host or receive the workload, at one instant.
 *
 * `hasPower` is the illumination question already answered: `sunlit_on` and
 * `sunlit_edge` are powered, everything else (umbra, penumbra, panel facing away)
 * is not. Folding it to a boolean here keeps this module free of the illumination
 * vocabulary — the caller maps the state, `noPower` is the shared definition.
 */
export interface MigrationHost {
  name: string;
  position: Vec3;
  hasPower: boolean;
}

/** km/s. Light in vacuum — the ISL propagation floor. */
export const SPEED_OF_LIGHT_KM_S = 299792.458;

/** km. Earth's mean radius, the sphere an inter-satellite link cannot see through. */
export const EARTH_RADIUS_KM = 6371;

/**
 * Whether two satellites can see each other, or whether the Earth is between them.
 *
 * The constraint the naive model was missing and could not have noticed on its own:
 * picking the *nearest powered* satellite by straight-line distance happily selects
 * one on the other side of the planet. At 550 km altitude two satellites 11,000 km
 * apart have a chord whose closest approach to Earth's centre is about 4,060 km —
 * deep inside the planet — so the "link" the animation drew was through rock.
 *
 * The test is the closest approach of the *segment* to the origin, which is where
 * both frames agree: the Earth is centred on the origin in the fixed frame and in
 * the inertial frame alike, so the same check is valid for whichever frame the
 * caller sampled positions in.
 *
 * `marginKm` raises the sphere to keep a grazing link honest — a ray skimming the
 * limb passes through the atmosphere, where an optical ISL does not work. Default 80
 * km, roughly the top of the mesosphere.
 */
export function hasLineOfSight(a: Vec3, b: Vec3, marginKm: number = 80): boolean {
  const blocking = EARTH_RADIUS_KM + marginKm;
  // Work in km so the radius comparison is direct.
  const ax = a.x / 1000;
  const ay = a.y / 1000;
  const az = a.z / 1000;
  const dx = b.x / 1000 - ax;
  const dy = b.y / 1000 - ay;
  const dz = b.z / 1000 - az;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) {
    return true;
  }
  // Projection of the origin onto the line, clamped to the segment: the closest
  // approach has to be *between* the satellites to occlude the link. Clamping is
  // what stops a pair on the same side of the Earth being called blocked by the
  // far limb.
  const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy + az * dz) / lengthSquared));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  const cz = az + dz * t;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) >= blocking;
}

/**
 * Whether an illumination state means the compute node cannot be powered.
 *
 * The one definition of "dark" shared with the panel's census: a node is powered
 * only when its panel is actually receiving sunlight (`sunlit_on` / `sunlit_edge`).
 * `sunlit_back` looks lit to an eclipse-only model and still has no power, which is
 * exactly the case a migration has to react to.
 */
export function noPower(state: string): boolean {
  return state !== "sunlit_on" && state !== "sunlit_edge";
}

/** The straight-line chord between two satellites, in km. */
export function distanceKm(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / 1000;
}

/**
 * A point a fraction of the way from `a` to `b`, clamped to the segment.
 *
 * The packet's position while it is in flight. Clamped rather than extrapolated so
 * a fraction that overshoots by a frame draws the packet arrived, not past the
 * target.
 */
export function lerp(a: Vec3, b: Vec3, fraction: number): Vec3 {
  const t = Math.min(1, Math.max(0, fraction));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** How far along its link a packet is, and whether it has got there. */
export interface FlightProgress {
  /** Position along the link, 0 at the source and 1 on arrival. Never outside that. */
  fraction: number;
  /** True once the flight is over and the stage should be landed on its destination. */
  arrived: boolean;
}

/**
 * How far a flight that left at `startSimMs` has got by `currentSimMs`, given an
 * on-screen duration of `durationSimSeconds`.
 *
 * All three are **simulated** milliseconds/seconds, read from the demo clock rather
 * than from `performance.now()`. That is the whole point (LAB-89): the packet then
 * moves in the same timebase as the satellites it is flying between, so the clock's
 * multiplier speeds the migration up exactly as it speeds the orbit up, and pausing
 * freezes the packet mid-link instead of letting it sail on.
 *
 * The clock is not a monotonic source, though — the time controls can pause it,
 * scrub it, jump it or run it backwards — so the three degenerate cases are answered
 * here rather than left to overflow a fraction on screen:
 *
 * - **Paused**: the elapsed simulated time stops growing, so the fraction holds and
 *   the packet sits still. Nothing special needed; it falls out of the arithmetic.
 * - **Scrubbed or jumped forward**: the fraction passes 1 in one step and the flight
 *   is simply `arrived`. An animation cannot be replayed across a jump the pipeline
 *   did not live through, and landing is the only state that leaves the stage
 *   somewhere real.
 * - **Rewound behind the departure** (a scrub back, or a negative multiplier): the
 *   elapsed time goes negative, which has no position on the link, so the flight is
 *   landed too. Clamping to 0 instead would look tidier and strand the stage
 *   mid-migration forever, since nothing else ever completes it.
 */
export function flightProgress(startSimMs: number, currentSimMs: number, durationSimSeconds: number): FlightProgress {
  const elapsedSeconds = (currentSimMs - startSimMs) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || !(durationSimSeconds > 0)) {
    return { fraction: 1, arrived: true };
  }
  const fraction = elapsedSeconds / durationSimSeconds;
  return fraction >= 1 ? { fraction: 1, arrived: true } : { fraction, arrived: false };
}

/** What a single transfer costs, broken into the two terms that make it up. */
export interface TransferCost {
  /** Time to push the bytes onto the link: KV size / bandwidth. */
  serializeSeconds: number;
  /** One-way light travel over the link's length. */
  propagationSeconds: number;
  /** The naive total — the two in series, no overlap. */
  totalSeconds: number;
}

/**
 * The cost of moving `kvGigabytes` over one `islGbps` link that is `linkKm` long.
 *
 * Naive on purpose: serialisation and propagation in series, once, with no
 * acknowledgement round trips and no overlap between sending and computing. For a
 * few GB over 100 Gbps the serialisation term dominates by orders of magnitude
 * (2 GB is 160 ms; 2000 km of propagation is 6.7 ms), which is itself the point —
 * the bottleneck is the KV cache size against the link, not the distance, and that
 * is what the algorithm work gets to attack.
 *
 * GB are gibi-agnostic here: 1 GB is taken as 8 gigabits, so GB × 8 / Gbps is
 * seconds directly. Close enough for a figure whose job is to show the order of
 * magnitude next to a moving dot.
 */
export function transferCost(kvGigabytes: number, islGbps: number, linkKm: number): TransferCost {
  const serializeSeconds = islGbps > 0 ? (kvGigabytes * 8) / islGbps : Infinity;
  const propagationSeconds = Math.max(0, linkKm) / SPEED_OF_LIGHT_KM_S;
  return { serializeSeconds, propagationSeconds, totalSeconds: serializeSeconds + propagationSeconds };
}

/**
 * The nearest powered satellite other than the source, or undefined if none is
 * lit.
 *
 * Nearest, because over one link the only thing the naive model can prefer is a
 * shorter transfer — and the chord is a stand-in for the real ISL, which does not
 * exist in this element set. A tie keeps the first seen, so the choice is
 * deterministic for a fixed candidate order.
 */
export function chooseTarget(source: MigrationHost, candidates: readonly MigrationHost[]): MigrationHost | undefined {
  let best: MigrationHost | undefined;
  let bestKm = Infinity;
  for (const candidate of candidates) {
    if (candidate.name === source.name || !candidate.hasPower) {
      continue;
    }
    const km = distanceKm(source.position, candidate.position);
    if (km < bestKm) {
      bestKm = km;
      best = candidate;
    }
  }
  return best;
}

/** What the model wants to happen to the workload right now. */
export interface MigrationDecision {
  action: "hold" | "migrate" | "stranded";
  /** Where to migrate, when `action` is `migrate`. */
  target?: MigrationHost;
  /** One line for the readout: why. */
  reason: string;
}

/**
 * Decide the fate of a workload currently hosted on `host`, given every satellite
 * that could take it.
 *
 * Three answers:
 * - `hold` — the host still has power; nothing to do.
 * - `migrate` — the host has gone dark and a lit neighbour exists; move there.
 * - `stranded` — the host has gone dark and *no* neighbour is lit either. The naive
 *   model has nowhere to go; the algorithm line's whole reason to exist. Named
 *   rather than folded into `hold` so the visual can say the workload is stuck
 *   rather than fine.
 *
 * The host is looked up by name in `hosts` so a caller can pass the live list and
 * a stale host name resolves to "gone" (stranded with no candidates) rather than a
 * crash.
 */
export function decideMigration(hostName: string | undefined, hosts: readonly MigrationHost[]): MigrationDecision {
  const host = hosts.find((candidate) => candidate.name === hostName);
  if (!host) {
    return { action: "stranded", reason: "No host holds the workload yet." };
  }
  if (host.hasPower) {
    return { action: "hold", reason: `${host.name} is powered — no migration needed.` };
  }
  const target = chooseTarget(host, hosts);
  if (!target) {
    return { action: "stranded", reason: `${host.name} lost power and no neighbour is lit — workload stranded.` };
  }
  return { action: "migrate", target, reason: `${host.name} lost power — migrating to ${target.name}.` };
}

/**
 * Which satellite should hold the workload when the demo starts.
 *
 * The powered satellite nearest the centre of the powered set is not worth
 * computing; the first powered one in the list is enough, and falls back to the
 * first host of all so the demo always has somewhere to begin. Deterministic for a
 * fixed order, which is what the browser check relies on.
 */
export function initialHost(hosts: readonly MigrationHost[]): MigrationHost | undefined {
  return hosts.find((host) => host.hasPower) ?? hosts[0];
}

// ---------------------------------------------------------------------------
// A pipeline of stages, rather than one workload
// ---------------------------------------------------------------------------
//
// The single-workload model above answers "where should this KV cache live". An
// inference pipeline asks a harder question, and it is the one LAB-47 actually
// cares about: a decode pipeline is cut into stages, every stage holds its own KV
// cache on its own satellite, and the pipeline only produces tokens while *every*
// stage has power at the same instant. One stage in shadow stalls all of them.
//
// That is why the stage count matters rather than being decoration: with one
// workload the fleet's ~45% dark fraction is the whole story, but a 4-stage
// pipeline needs four coincidences at once, so the same per-satellite dark
// fraction buys far less served time. `pipelineServing` is where that shows up,
// and the ledger is what turns it into a number.

/**
 * One pipeline stage and the satellite currently holding its KV cache.
 *
 * `hostName` is undefined only before the stage has been placed, or after its host
 * left the scene — the layer re-places it on the next evaluation.
 */
export interface StagePlacement {
  /** 0-based position in the pipeline. Stage order is fixed; hosts move. */
  index: number;
  hostName?: string;
}

/**
 * `chooseTarget`, but refusing satellites another stage already occupies.
 *
 * One stage per satellite. Not a physical law — a satellite could in principle
 * hold two stages — but it is the placement the pipeline story needs: co-locating
 * every stage on one satellite would make the pipeline a single point of failure
 * and would make the visual a single dot. Excluding taken hosts is also what
 * spreads the stages across orbital planes, which is the thing worth looking at.
 *
 * Line of sight is preferred but not required. "Nearest powered" by raw chord
 * length will pick a satellite on the far side of the planet, and the link drawn
 * to it goes straight through the Earth — so a candidate still in view is chosen
 * ahead of an occluded one. But a powered neighbour is not always in view at all:
 * with a zenith panel the powered set is the sunlit face of the fleet, so a
 * satellite that has just gone dark sees every lit neighbour over the far limb.
 * Refusing that hop would strand the stage on a dark (`sunlit_back`) node for
 * half an orbit, which the illumination vocabulary exists to call wrong. So the
 * fallback is the nearest powered satellite, occluded or not, and `stranded` is
 * reserved for when no powered satellite is free at all.
 */
export function chooseTargetExcluding(source: MigrationHost, candidates: readonly MigrationHost[], taken: ReadonlySet<string>): MigrationHost | undefined {
  let nearestInView: MigrationHost | undefined;
  let nearestInViewKm = Infinity;
  let nearest: MigrationHost | undefined;
  let nearestKm = Infinity;
  for (const candidate of candidates) {
    if (candidate.name === source.name || !candidate.hasPower || taken.has(candidate.name)) {
      continue;
    }
    const km = distanceKm(source.position, candidate.position);
    if (km < nearestKm) {
      nearestKm = km;
      nearest = candidate;
    }
    if (hasLineOfSight(source.position, candidate.position) && km < nearestInViewKm) {
      nearestInViewKm = km;
      nearestInView = candidate;
    }
  }
  return nearestInView ?? nearest;
}

/**
 * `decideMigration` for one stage of a pipeline, given the hosts its siblings hold.
 *
 * Same three answers as the single-workload model, with one difference: a lit
 * neighbour already carrying another stage is not a candidate. So `stranded` here
 * means "dark, and every powered satellite is either mine already or someone
 * else's" — a scarcity the single-workload model cannot express, and one of the two
 * ways the naive policy visibly runs out of room. Line of sight no longer strands a
 * stage on its own; an occluded hop is still made rather than sitting dark (see
 * `chooseTargetExcluding`).
 */
export function decideStageMigration(hostName: string | undefined, hosts: readonly MigrationHost[], taken: ReadonlySet<string>): MigrationDecision {
  const host = hosts.find((candidate) => candidate.name === hostName);
  if (!host) {
    return { action: "stranded", reason: "Stage is unplaced." };
  }
  if (host.hasPower) {
    return { action: "hold", reason: `${host.name} is powered — no migration needed.` };
  }
  const target = chooseTargetExcluding(host, hosts, taken);
  if (!target) {
    return { action: "stranded", reason: `${host.name} lost power and no powered satellite is free — stage stranded.` };
  }
  return { action: "migrate", target, reason: `${host.name} lost power — migrating to ${target.name}.` };
}

/**
 * Put `count` stages on distinct powered satellites, in list order.
 *
 * Powered first so the pipeline starts in a serving state where possible; falls
 * back to unpowered satellites once the lit ones run out, so a pipeline longer
 * than the lit fleet still places every stage (and immediately reports itself
 * stalled, which is the honest answer rather than a missing stage). Deterministic
 * for a fixed host order, which the browser check depends on.
 */
export function placeStages(count: number, hosts: readonly MigrationHost[]): StagePlacement[] {
  const taken = new Set<string>();
  const stages: StagePlacement[] = [];
  const inPowerOrder = [...hosts.filter((host) => host.hasPower), ...hosts.filter((host) => !host.hasPower)];
  for (let index = 0; index < count; index += 1) {
    const free = inPowerOrder.find((host) => !taken.has(host.name));
    if (free) {
      taken.add(free.name);
    }
    stages.push({ index, hostName: free?.name });
  }
  return stages;
}

/**
 * Whether the pipeline is producing tokens right now.
 *
 * True only when every stage sits on a satellite that currently has power. A stage
 * mid-migration is not serving either — the caller passes `false` for it by
 * leaving its host unpowered or by excluding it, whichever matches the phase it is
 * drawing. This is the whole reason a pipeline is harder than a workload: the
 * serving condition is a conjunction over stages, so it fails far more often than
 * any single stage does.
 */
export function pipelineServing(stages: readonly StagePlacement[], hosts: readonly MigrationHost[]): boolean {
  if (stages.length === 0) {
    return false;
  }
  return stages.every((stage) => {
    const host = hosts.find((candidate) => candidate.name === stage.hostName);
    return host?.hasPower === true;
  });
}

/** How many of the pipeline's stages currently sit on a powered satellite. */
export function poweredStageCount(stages: readonly StagePlacement[], hosts: readonly MigrationHost[]): number {
  return stages.filter((stage) => hosts.find((candidate) => candidate.name === stage.hostName)?.hasPower === true).length;
}

/**
 * What the naive policy has cost since the demo was switched on.
 *
 * Kept as a value rather than mutable counters so the panel can read a consistent
 * snapshot, and so the accounting is testable without a globe. Seconds are
 * *simulated* seconds throughout — the demo clock runs at 60× or more, and a cost
 * measured in wall time would be an artefact of the playback rate, not of the
 * orbit.
 *
 * The time split is deliberately about **power geometry only**: whether a packet
 * happens to be mid-animation is not part of it. The flight now runs on the
 * simulation clock like everything else, so counting it would at least be
 * multiplier-independent — but its 30 simulated seconds are an illustrative duration
 * some 180× the real transfer, so charging them as stalled time would overstate what
 * migrating costs by the same factor. The transfers' actual cost is
 * `transferSeconds`, computed from the link arithmetic.
 */
export interface MigrationLedger {
  /** Completed stage migrations. */
  migrations: number;
  /** KV cache actually pushed across links, in GB. */
  gigabytesMoved: number;
  /** Summed transfer cost of those migrations, in seconds of link time. */
  transferSeconds: number;
  /** Simulated seconds at least one stage lacked power, so the pipeline could not run. */
  stalledSeconds: number;
  /** Simulated seconds every stage had power at once. */
  allPoweredSeconds: number;
}

export function emptyLedger(): MigrationLedger {
  return { migrations: 0, gigabytesMoved: 0, transferSeconds: 0, stalledSeconds: 0, allPoweredSeconds: 0 };
}

/** The ledger with one completed migration of `kvGigabytes` costing `cost` added. */
export function recordMigration(ledger: MigrationLedger, kvGigabytes: number, cost: TransferCost): MigrationLedger {
  return {
    ...ledger,
    migrations: ledger.migrations + 1,
    gigabytesMoved: ledger.gigabytesMoved + kvGigabytes,
    transferSeconds: ledger.transferSeconds + cost.totalSeconds,
  };
}

/**
 * The ledger with `simSeconds` of elapsed simulated time attributed by whether
 * every stage had power.
 *
 * A negative or absurd delta is dropped rather than trusted: the demo clock can be
 * scrubbed, reversed or jumped by the time controls, and a jump is not time the
 * pipeline lived through. `maxStepSeconds` is the largest delta still treated as
 * continuous playback.
 */
export function accrueTime(ledger: MigrationLedger, simSeconds: number, allPowered: boolean, maxStepSeconds: number): MigrationLedger {
  if (!Number.isFinite(simSeconds) || simSeconds <= 0 || simSeconds > maxStepSeconds) {
    return ledger;
  }
  return allPowered ? { ...ledger, allPoweredSeconds: ledger.allPoweredSeconds + simSeconds } : { ...ledger, stalledSeconds: ledger.stalledSeconds + simSeconds };
}

/**
 * The fraction of accounted simulated time every stage had power at once — the
 * pipeline's ceiling on served time.
 *
 * A ceiling rather than the served fraction itself, because the transfers eat into
 * it: `transferSeconds` is what the migrations cost inside this window. Undefined
 * before any time has been accounted, so the panel can withhold a percentage rather
 * than print a confident 0% for a demo that has not started.
 */
export function allPoweredFraction(ledger: MigrationLedger): number | undefined {
  const total = ledger.allPoweredSeconds + ledger.stalledSeconds;
  return total > 0 ? ledger.allPoweredSeconds / total : undefined;
}

/** One completed migration, kept for the event log the panel prints. */
export interface MigrationEvent {
  /** Stage index that moved. */
  stage: number;
  from: string;
  to: string;
  linkKm: number;
  transferSeconds: number;
  /** Simulated time the migration was decided, as an ISO instant. */
  at: string;
}

import {
  ArcType,
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  Entity,
  JulianDate,
  LabelGraphics,
  LabelStyle,
  NearFarScalar,
  PointGraphics,
  PolylineGlowMaterialProperty,
  PolylineGraphics,
  VerticalOrigin,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { PanelAxis } from "../config/illumination";
import {
  DEFAULT_KV_GIGABYTES,
  DEFAULT_KV_INCREMENTAL,
  DEFAULT_MIGRATION_POLICY,
  DEFAULT_PIPELINE_STAGES,
  ISL_GBPS,
  KV_GROWTH_MB_PER_SECOND,
  MAX_SIM_STEP_SECONDS,
  MIGRATION_ANIMATION_SIM_SECONDS,
  MIGRATION_COLOR,
  MIGRATION_EVAL_SIM_SECONDS,
  MIGRATION_LOG_LENGTH,
  MIGRATION_PREDICTIVE_LOOKAHEAD_SIM_SECONDS,
  type MigrationPolicy,
  stageColor,
} from "../config/migration";
import type { SatelliteManager } from "./SatelliteManager";
import {
  accrueTime,
  decideStageMigration,
  deltaSnapshot,
  distanceKm,
  emptyLedger,
  flightProgress,
  type MigrationEvent,
  type MigrationHost,
  type MigrationLedger,
  type MigrationRoute,
  lerp,
  relaysOf,
  placeStages,
  poweredStageCount,
  recordMigration,
  allPoweredFraction,
  routeTransferCost,
  type TransferCost,
  type Vec3,
} from "./util/migration";
import { planeSlotOf } from "./util/walkerDelta";

/** What one pipeline stage is doing, for the panel's per-stage row. */
export interface MigrationStageStatus {
  /** 0-based position in the pipeline; the panel prints it 1-based. */
  index: number;
  phase: "holding" | "migrating" | "stranded";
  hostName?: string;
  from?: string;
  to?: string;
  linkKm?: number;
  /** The relay this stage's hop goes through, when it needs one and is migrating. */
  via?: string;
  transferSeconds?: number;
  /** What this migration is shipping, in GB — the full cache or a delta against the last sync. */
  payloadGigabytes?: number;
  /**
   * How far the packet has got along the link, 0–1, while `phase` is `migrating`;
   * undefined otherwise.
   *
   * Measured in simulated time, so it advances with the clock multiplier and holds
   * still while the clock is paused — which is what makes the sim anchoring
   * observable from outside the layer, for the panel and for the browser check.
   */
  progress?: number;
  /** Whether this stage's host currently has power. */
  powered: boolean;
  /** Whether this stage's host is predicted to have power in the lookahead window. */
  lookaheadPowered?: boolean;
  /** The hue this stage is drawn in, so the table and the globe agree. */
  color: string;
  reason: string;
}

/**
 * What the panel reads back about the migration in progress. A plain snapshot,
 * recomputed each evaluation, so a polling readout never touches the layer's
 * internals.
 *
 * The top-level `phase` / `hostName` / `linkKm` / `transferSeconds` fields describe
 * the pipeline as a whole and, when a migration is in flight, the stage that is
 * moving — they are what a glance wants. `stages` is the per-stage detail behind
 * them.
 */
export interface MigrationStatus {
  active: boolean;
  /** Current migration policy. */
  policy: MigrationPolicy;
  /** Whether transfers ship incremental KV deltas rather than full snapshots. */
  incremental: boolean;
  /** `migrating` if any stage is in flight, else `stranded` if any is stuck, else `holding`. */
  phase: "holding" | "migrating" | "stranded";
  hostName?: string;
  from?: string;
  to?: string;
  reason: string;
  kvGigabytes: number;
  islGbps: number;
  linkKm?: number;
  /** The relay the moving stage's hop goes through, when it needs one. */
  via?: string;
  transferSeconds?: number;
  /** The moving stage's progress along its link, 0–1, when one is in flight. */
  progress?: number;
  /** Completed migrations since the demo was switched on, across all stages. */
  migrations: number;
  /** How many stages the pipeline is cut into. */
  stageCount: number;
  /** Per-stage detail, in pipeline order. */
  stages: MigrationStageStatus[];
  /** True only while every stage sits on a powered satellite and none is in flight. */
  serving: boolean;
  /** How many stages currently have power. */
  poweredStages: number;
  /** The cost the naive policy has run up, in simulated time. */
  ledger: MigrationLedger;
  /** Share of accounted simulated time the pipeline was producing tokens. */
  allPoweredFraction?: number;
  /** The most recent completed migrations, newest first. */
  log: MigrationEvent[];
}

interface Flight {
  from: string;
  to: string;
  /**
   * Simulated instant the packet left, in ms, against which its progress along the
   * link is measured. Simulated rather than wall-clock so the flight shares the
   * clock with the satellites — see MIGRATION_ANIMATION_SIM_SECONDS.
   */
  startSimMs: number;
  cost: TransferCost;
  /** What this transfer ships, in GB — the full cache or a delta against the last sync. */
  payloadGigabytes: number;
  /** The whole wire, summed over the route's legs. */
  linkKm: number;
  /**
   * The path the cache takes: two hosts direct, three through a relay that can see
   * both ends. Held rather than recomputed per frame because the route is decided
   * once, at the instant the geometry was sampled — re-solving it while the packet
   * is in flight would let the line jump to a different relay mid-transfer.
   */
  route: MigrationRoute;
  /** Simulated instant the migration was decided, for the event log. */
  decidedAt: string;
}

/** One stage's live state: where it lives, and whether it is moving. */
interface StageState {
  index: number;
  hostName: string | undefined;
  flight: Flight | undefined;
  /**
   * Simulated instant this stage's last transfer completed, for the differential
   * snapshot: what the next transfer ships is what the cache appended since this
   * moment. Undefined until the first transfer lands.
   */
  lastSyncSimMs: number | undefined;
  /** The four entities drawing this stage. */
  entities: Entity[];
  /** Why the stage is where it is, last time the model was asked. */
  phase: "holding" | "migrating" | "stranded";
  reason: string;
}

/**
 * The naive live-migration overlay: an inference pipeline whose stages hop between
 * satellites as their hosts lose power.
 *
 * A scene-level layer rather than a per-satellite component (unlike Orbit or the
 * Illumination arc), because a migration is a *relation between two* satellites,
 * not a property of one — the link and the packet belong to neither endpoint. It
 * owns four entities per stage in the viewer's own collection and drives them from
 * the clock, reading positions live so each link stays glued to two moving
 * satellites and each packet slides between them.
 *
 * The decision logic lives in util/migration.ts and is tested there; this class is
 * the wiring — where each stage is, when a migration starts, how the entities
 * render it, and what the whole thing has cost.
 *
 * Two properties of the pipeline are the point of the overlay, and both come from
 * the conjunction rather than from any one stage:
 *
 * - It **serves only while every stage has power at once.** One stage in shadow
 *   stalls the pipeline, so the served fraction falls far below any single
 *   satellite's lit fraction.
 * - Stages **cannot share a satellite**, so as the lit set shrinks the naive policy
 *   runs out of room and strands stages — the scarcity the algorithm line exists to
 *   beat.
 *
 * Illumination is read on the **zenith** panel model on purpose: it is the one
 * axis whose κ changes sign within an orbit, so it is the one under which a
 * satellite actually crosses into `sunlit_back` and gives the demo something to
 * react to (see src/config/illumination.ts).
 */
export class MigrationLayer {
  readonly #viewer: Viewer;

  readonly #sats: SatelliteManager;

  readonly #kvGigabytes: number;

  #stageCount: number;

  #policy: MigrationPolicy;

  /** Whether transfers ship differential KV snapshots instead of full ones. */
  #incremental: boolean;

  #stages: StageState[] = [];

  /**
   * The pipeline drawn as a chain between consecutive stage hosts. Owned here
   * rather than on a stage because a segment belongs to two stages: it is the
   * inter-satellite link the workload crosses, and it is on screen whether or
   * not anything is in flight across it right now.
   */
  #pipelineLinks: Entity[] = [];

  #removeTick: (() => void) | undefined;

  /** Simulated time the migration decision last ran, for throttling it. */
  #lastEvalSimMs: number | undefined;

  #ledger: MigrationLedger = emptyLedger();

  #log: MigrationEvent[] = [];

  /** Simulated time at the previous tick, for accruing served/stalled seconds. */
  #lastSimMs: number | undefined;

  #status: MigrationStatus;

  constructor(
    viewer: Viewer,
    sats: SatelliteManager,
    kvGigabytes: number = DEFAULT_KV_GIGABYTES,
    stageCount: number = DEFAULT_PIPELINE_STAGES,
    policy: MigrationPolicy = DEFAULT_MIGRATION_POLICY,
    incremental: boolean = DEFAULT_KV_INCREMENTAL,
  ) {
    this.#viewer = viewer;
    this.#sats = sats;
    this.#kvGigabytes = kvGigabytes;
    this.#stageCount = stageCount;
    this.#policy = policy;
    this.#incremental = incremental;
    this.#status = this.#idleStatus();
  }

  get status(): MigrationStatus {
    return this.#status;
  }

  /** Set migration strategy: predictive (pre-eclipse handoff) vs naive (reactive). */
  setPolicy(policy: MigrationPolicy): void {
    if (policy === this.#policy) {
      return;
    }
    this.#policy = policy;
    this.#lastEvalSimMs = undefined; // re-evaluate immediately on policy switch
    if (this.#removeTick) {
      this.#viewer.scene.requestRender();
    }
  }

  /**
   * Switch between full-snapshot and differential-snapshot transfers.
   *
   * Affects flights decided from now on; the ledger keeps what it has already
   * recorded, since the point of the toggle is comparing the two regimes and
   * rewriting history would hide the difference.
   */
  setIncremental(on: boolean): void {
    if (on === this.#incremental) {
      return;
    }
    this.#incremental = on;
    this.#lastEvalSimMs = undefined;
    if (this.#removeTick) {
      this.#viewer.scene.requestRender();
    }
  }

  /** The panel axis the migration reasons on. Fixed — see the class comment. */
  static readonly AXIS: PanelAxis = "zenith";

  start(): void {
    if (this.#removeTick) {
      return;
    }
    this.#buildStages();
    // Per clock tick, which is per rendered frame — the packets and links read
    // live positions there, and the decision is throttled inside the handler.
    this.#removeTick = this.#viewer.clock.onTick.addEventListener(() => this.#tick());
    this.#viewer.scene.requestRender();
  }

  stop(): void {
    this.#removeTick?.();
    this.#removeTick = undefined;
    this.#teardownStages();
    this.#ledger = emptyLedger();
    this.#log = [];
    this.#lastSimMs = undefined;
    this.#lastEvalSimMs = undefined;
    this.#status = this.#idleStatus();
    this.#viewer.scene.requestRender();
  }

  /**
   * Re-cut the pipeline into `count` stages.
   *
   * A different stage count is a different pipeline, so the ledger and the log are
   * reset with it — carrying migration counts across a change of pipeline length
   * would make the served fraction a blend of two different experiments. Cheap
   * enough to rebuild the entities outright while the overlay is live.
   */
  setStageCount(count: number): void {
    if (count === this.#stageCount) {
      return;
    }
    this.#stageCount = count;
    if (!this.#removeTick) {
      return;
    }
    this.#teardownStages();
    this.#ledger = emptyLedger();
    this.#log = [];
    this.#lastSimMs = undefined;
    this.#lastEvalSimMs = undefined;
    this.#buildStages();
    this.#viewer.scene.requestRender();
  }

  #buildStages(): void {
    this.#stages = [];
    for (let index = 0; index < this.#stageCount; index += 1) {
      const stage: StageState = { index, hostName: undefined, flight: undefined, lastSyncSimMs: undefined, entities: [], phase: "stranded", reason: "Stage is unplaced." };
      stage.entities = this.#buildEntities(stage);
      for (const entity of stage.entities) {
        this.#viewer.entities.add(entity);
      }
      this.#stages.push(stage);
    }
    this.#buildPipelineLinks();
  }

  /**
   * One standing segment per consecutive pair of stages.
   *
   * Without these the pipeline is four haloes drifting over a fleet, and nothing
   * says which satellite runs the stage before or after any other — the hop is
   * only legible for the thirty simulated seconds its own link is drawn. Drawing
   * the whole chain makes the pipeline's shape readable at a glance, and makes a
   * hop look like what it is: one segment of that chain lighting up.
   */
  #buildPipelineLinks(): void {
    for (let index = 0; index + 1 < this.#stageCount; index += 1) {
      const hue = Color.fromCssColorString(stageColor(index));
      const link = new Entity({
        name: `Pipeline link S${index + 1}-S${index + 2}`,
        polyline: new PolylineGraphics({
          positions: new CallbackProperty((time?: JulianDate) => this.#pipelinePositions(index, index + 1, time ?? this.#viewer.clock.currentTime), false),
          width: 2,
          material: new ColorMaterialProperty(hue.withAlpha(0.55)),
          // Straight chord between the two satellites, not draped on the globe.
          // ArcType.NONE explicitly: PolylineGraphics reads an undefined arcType
          // as its default, which is GEODESIC — so "undefined" asked for the
          // draped arc rather than for no arc, and a pair that happened to be
          // near-antipodal threw out of EllipsoidGeodesic.setEndPoints and
          // stopped the whole scene rendering.
          arcType: ArcType.NONE,
        }),
      });
      this.#pipelineLinks.push(link);
      this.#viewer.entities.add(link);
    }
  }

  /**
   * The endpoints of the segment joining two stage hosts, or [] while either is
   * unplaced — a stage has no host until the pipeline is first laid out.
   */
  #pipelinePositions(fromIndex: number, toIndex: number, time: JulianDate): Cartesian3[] {
    const from = this.#positionAt(this.#stages[fromIndex]?.hostName, time);
    const to = this.#positionAt(this.#stages[toIndex]?.hostName, time);
    return from && to ? [from, to] : [];
  }

  #teardownStages(): void {
    for (const link of this.#pipelineLinks) {
      this.#viewer.entities.remove(link);
    }
    this.#pipelineLinks = [];
    for (const stage of this.#stages) {
      for (const entity of stage.entities) {
        this.#viewer.entities.remove(entity);
      }
    }
    this.#stages = [];
  }

  #idleStatus(): MigrationStatus {
    return {
      active: false,
      policy: this.#policy,
      incremental: this.#incremental,
      phase: "holding",
      reason: "Migration demo is off.",
      kvGigabytes: this.#kvGigabytes,
      islGbps: ISL_GBPS,
      migrations: 0,
      stageCount: this.#stageCount,
      stages: [],
      serving: false,
      poweredStages: 0,
      ledger: emptyLedger(),
      log: [],
    };
  }

  /** The live position of a named satellite, or undefined if it is gone. */
  #positionAt(name: string | undefined, time: JulianDate): Cartesian3 | undefined {
    if (!name) {
      return undefined;
    }
    return this.#sats.getSatellite(name)?.props.trajectory.position(time);
  }

  /** Every active satellite as a migration host, at `date`. */
  #hostsAt(date: Date, time: JulianDate): MigrationHost[] {
    const hosts: MigrationHost[] = [];
    const lookaheadDate = new Date(date.getTime() + MIGRATION_PREDICTIVE_LOOKAHEAD_SIM_SECONDS * 1000);
    for (const sat of this.#sats.activeSatellites) {
      const position = sat.props.trajectory.position(time);
      const illumination = sat.props.illumination(date, MigrationLayer.AXIS);
      if (!position || !illumination) {
        continue;
      }
      const lookaheadIllumination = sat.props.illumination(lookaheadDate, MigrationLayer.AXIS);
      hosts.push({
        name: sat.props.name,
        position: { x: position.x, y: position.y, z: position.z },
        hasPower: illumination.state === "sunlit_on" || illumination.state === "sunlit_edge",
        lookaheadPower: lookaheadIllumination ? lookaheadIllumination.state === "sunlit_on" || lookaheadIllumination.state === "sunlit_edge" : undefined,
      });
    }
    return hosts;
  }

  /** Hosts spoken for by stages other than `self` — either held or being migrated to. */
  #takenBySiblings(self: StageState): Set<string> {
    const taken = new Set<string>();
    for (const stage of this.#stages) {
      if (stage === self) {
        continue;
      }
      if (stage.hostName) {
        taken.add(stage.hostName);
      }
      // A stage in flight still owns its destination, or two stages would race
      // onto the same satellite and land co-located.
      if (stage.flight) {
        taken.add(stage.flight.to);
      }
    }
    return taken;
  }

  #tick(): void {
    const time = this.#viewer.clock.currentTime;
    const date = JulianDate.toDate(time);
    const simMs = date.getTime();
    const hosts = this.#hostsAt(date, time);

    if (hosts.length < 2 || this.#stages.length === 0) {
      this.#status = {
        ...this.#idleStatus(),
        active: true,
        phase: "stranded",
        reason: "Waiting for the demo scene — need at least two satellites.",
      };
      return;
    }

    // Place any stage that has no host, or whose host left the scene. Done for the
    // whole pipeline at once so the placement respects one-stage-per-satellite.
    if (this.#stages.some((stage) => !stage.hostName || !hosts.some((host) => host.name === stage.hostName))) {
      this.#replaceMissingStages(hosts);
    }

    // Land any in-flight migration whose packet has arrived — on the simulation
    // clock, the same one the packet is drawn against, so a stage lands where the dot
    // is seen to touch down whatever the multiplier is.
    for (const stage of this.#stages) {
      const flight = stage.flight;
      if (!flight) {
        continue;
      }
      if (flightProgress(flight.startSimMs, simMs, MIGRATION_ANIMATION_SIM_SECONDS).arrived) {
        stage.hostName = flight.to;
        stage.flight = undefined;
        // The landing is the differential snapshot's sync point: what the next
        // transfer ships is what the cache appends from here.
        stage.lastSyncSimMs = simMs;
        this.#ledger = recordMigration(this.#ledger, flight.payloadGigabytes, this.#kvGigabytes, flight.cost);
        this.#log = [
          {
            stage: stage.index,
            from: flight.from,
            to: flight.to,
            linkKm: flight.linkKm,
            hops: flight.route.hops,
            legsKm: flight.route.legsKm,
            payloadGigabytes: flight.payloadGigabytes,
            transferSeconds: flight.cost.totalSeconds,
            at: flight.decidedAt,
          },
          ...this.#log,
        ].slice(0, MIGRATION_LOG_LENGTH);
      }
    }

    // Decide only every MIGRATION_EVAL_SIM_SECONDS of simulated time — a migration is
    // a state change a person reads, not a per-frame animation, and throttling it on
    // the clock rather than on wall time keeps the pipeline's reaction time a property
    // of the orbit instead of the playback rate. Compared on magnitude so a scrub in
    // either direction just re-decides rather than latching the throttle shut.
    if (this.#lastEvalSimMs === undefined || Math.abs(simMs - this.#lastEvalSimMs) >= MIGRATION_EVAL_SIM_SECONDS * 1000) {
      this.#lastEvalSimMs = simMs;
      this.#decideAll(hosts, simMs, date);
    }

    this.#accrueTime(date, hosts);
    this.#status = this.#composeStatus(hosts, simMs);
    this.#viewer.scene.requestRender();
  }

  /**
   * Give every unplaced stage a host, keeping the ones already placed where they
   * are.
   *
   * Placement runs over the satellites nobody holds, so a pipeline that lost one
   * stage's host does not get reshuffled wholesale — only the gap is filled.
   */
  #replaceMissingStages(hosts: readonly MigrationHost[]): void {
    const held = new Set<string>();
    for (const stage of this.#stages) {
      if (stage.hostName && hosts.some((host) => host.name === stage.hostName)) {
        held.add(stage.hostName);
      }
    }
    const gaps = this.#stages.filter((stage) => !stage.hostName || !hosts.some((host) => host.name === stage.hostName));
    const free = hosts.filter((host) => !held.has(host.name));
    const placements = placeStages(gaps.length, free);
    gaps.forEach((stage, index) => {
      stage.hostName = placements[index]?.hostName;
      stage.flight = undefined;
    });
  }

  /** Ask the model about every stage that is not already in flight. */
  #decideAll(hosts: readonly MigrationHost[], simMs: number, date: Date): void {
    for (const stage of this.#stages) {
      if (stage.flight) {
        stage.phase = "migrating";
        stage.reason = `Migrating ${this.#describePayload(stage)}: ${stage.flight.from} → ${stage.flight.to}.`;
        continue;
      }
      const decision = decideStageMigration(stage.hostName, hosts, this.#takenBySiblings(stage), this.#policy);
      stage.reason = decision.reason;
      if (decision.action === "migrate" && decision.target) {
        const host = hosts.find((candidate) => candidate.name === stage.hostName);
        if (host) {
          // The wire, not the straight line between the ends: a relayed hop is two
          // legs long, and the transfer is charged for what it actually traverses —
          // store-and-forward, so the serialisation is paid once per leg, not once
          // for the whole wire.
          const route = decision.route ?? {
            hops: [host.name, decision.target.name],
            legsKm: [distanceKm(host.position, decision.target.position)],
            linkKm: distanceKm(host.position, decision.target.position),
          };
          // Under incremental sync the payload is what the cache appended since
          // this stage's last completed transfer, plus what arrives while the
          // delta itself serialises; see deltaSnapshot.
          const delta = this.#incremental
            ? deltaSnapshot(this.#kvGigabytes, KV_GROWTH_MB_PER_SECOND, stage.lastSyncSimMs === undefined ? undefined : (simMs - stage.lastSyncSimMs) / 1000, ISL_GBPS)
            : { gigabytes: this.#kvGigabytes };
          stage.flight = {
            from: host.name,
            to: decision.target.name,
            startSimMs: simMs,
            cost: routeTransferCost(delta.gigabytes, ISL_GBPS, route.legsKm),
            payloadGigabytes: delta.gigabytes,
            linkKm: route.linkKm,
            route,
            decidedAt: date.toISOString(),
          };
          stage.phase = "migrating";
          continue;
        }
      }
      stage.phase = decision.action === "stranded" ? "stranded" : "holding";
    }
  }

  /** The readout of what a stage's in-flight transfer is shipping. */
  #describePayload(stage: StageState): string {
    const payload = stage.flight?.payloadGigabytes ?? this.#kvGigabytes;
    return payload < this.#kvGigabytes ? `${(payload * 1024).toFixed(0)} MB delta` : `${payload} GB`;
  }

  /**
   * Attribute the simulated time since the last tick to serving or stalling.
   *
   * Simulated rather than wall time because the demo runs at 60× or more, so a cost
   * measured in wall seconds would describe the playback rate rather than the
   * orbit. `accrueTime` drops jumps, which is what makes scrubbing the clock safe.
   *
   * Accrued on `#allPowered` rather than on `#serving`: whether a packet is
   * mid-flight is an *animation* state. Since LAB-89 the animation runs on the
   * simulation clock, so counting flights here would no longer make the fraction a
   * function of the multiplier — but it would still be wrong, because
   * MIGRATION_ANIMATION_SIM_SECONDS is an illustrative 30 simulated seconds against a
   * computed transfer of ~0.17 s, so charging it as stalled time would overstate the
   * cost of migrating by some 180×. What the ledger measures instead is pure
   * geometry: how much simulated time every stage had power at once. The transfers'
   * real cost is accounted separately, in `transferSeconds`, from the link arithmetic
   * rather than from the animation.
   */
  #accrueTime(date: Date, hosts: readonly MigrationHost[]): void {
    const simMs = date.getTime();
    if (this.#lastSimMs !== undefined) {
      this.#ledger = accrueTime(this.#ledger, (simMs - this.#lastSimMs) / 1000, this.#allPowered(hosts), MAX_SIM_STEP_SECONDS);
    }
    this.#lastSimMs = simMs;
  }

  /**
   * Whether every stage currently sits on a satellite with power.
   *
   * The geometric serving condition, and the one the ledger accounts on — a
   * conjunction over stages, which is why it fails far more often than any single
   * satellite's eclipse does.
   */
  #allPowered(hosts: readonly MigrationHost[]): boolean {
    if (this.#stages.length === 0) {
      return false;
    }
    return this.#stages.every((stage) => hosts.find((host) => host.name === stage.hostName)?.hasPower === true);
  }

  /**
   * Whether the pipeline is producing tokens right now: every stage powered, and no
   * stage mid-transfer.
   *
   * The instantaneous badge rather than the accounting measure (see `#accrueTime`):
   * a stage mid-migration is genuinely down, because a naive migration has no
   * handshake overlap — but the on-screen flight lasts an illustrative 30 simulated
   * seconds, not the computed 170 ms, so this drives the readout and not the ledger.
   */
  #serving(hosts: readonly MigrationHost[]): boolean {
    return this.#allPowered(hosts) && this.#stages.every((stage) => !stage.flight);
  }

  #composeStatus(hosts: readonly MigrationHost[], simMs: number): MigrationStatus {
    const stages: MigrationStageStatus[] = this.#stages.map((stage) => ({
      index: stage.index,
      phase: stage.phase,
      hostName: stage.hostName,
      from: stage.flight?.from,
      to: stage.flight?.to,
      linkKm: stage.flight?.linkKm,
      via: stage.flight && relaysOf(stage.flight.route).join(" → ") ? relaysOf(stage.flight.route).join(" → ") : undefined,
      payloadGigabytes: stage.flight?.payloadGigabytes,
      transferSeconds: stage.flight?.cost.totalSeconds,
      progress: stage.flight ? flightProgress(stage.flight.startSimMs, simMs, MIGRATION_ANIMATION_SIM_SECONDS).fraction : undefined,
      powered: hosts.find((host) => host.name === stage.hostName)?.hasPower === true,
      lookaheadPowered: hosts.find((host) => host.name === stage.hostName)?.lookaheadPower,
      color: stageColor(stage.index),
      reason: stage.reason,
    }));

    // The pipeline's headline is the worst thing happening to it: a stage in flight
    // if there is one, else a stranded stage, else holding.
    const moving = stages.find((stage) => stage.phase === "migrating");
    const stuck = stages.find((stage) => stage.phase === "stranded");
    const lead = moving ?? stuck;
    const phase: MigrationStatus["phase"] = moving ? "migrating" : stuck ? "stranded" : "holding";
    const serving = this.#serving(hosts);
    const powered = poweredStageCount(
      this.#stages.map((stage) => ({ index: stage.index, hostName: stage.hostName })),
      hosts,
    );

    return {
      active: true,
      policy: this.#policy,
      incremental: this.#incremental,
      phase,
      hostName: lead?.hostName ?? stages[0]?.hostName,
      from: moving?.from,
      to: moving?.to,
      linkKm: moving?.linkKm,
      via: moving?.via,
      transferSeconds: moving?.transferSeconds,
      progress: moving?.progress,
      reason: serving ? `All ${stages.length} stages powered — pipeline serving.` : (lead?.reason ?? `${powered}/${stages.length} stages powered — pipeline stalled.`),
      kvGigabytes: this.#kvGigabytes,
      islGbps: ISL_GBPS,
      migrations: this.#ledger.migrations,
      stageCount: this.#stageCount,
      stages,
      serving,
      poweredStages: powered,
      ledger: this.#ledger,
      allPoweredFraction: allPoweredFraction(this.#ledger),
      log: this.#log,
    };
  }

  /** The two endpoints of `stage`'s link, or [] when it is not migrating. */
  #linkPositions(stage: StageState, time: JulianDate): Cartesian3[] {
    if (!stage.flight) {
      return [];
    }
    const points = stage.flight.route.hops.map((hop) => this.#positionAt(hop, time));
    // All or nothing: a relay that left the scene mid-flight would otherwise draw a
    // straight line between the ends, which is the one line this route exists to
    // avoid claiming.
    return points.every((point) => point !== undefined) ? (points as Cartesian3[]) : [];
  }

  /**
   * Where `stage`'s packet is: along the link while migrating, else on its host.
   *
   * The fraction comes from `time` — the instant Cesium is drawing — and not from
   * `performance.now()`, which is what made the packet crawl at one fixed speed
   * however fast the clock was running (LAB-89). Reading the frame's own simulated
   * time also keeps the dot consistent with the two endpoints, which are sampled from
   * that same instant.
   */
  #packetPosition(stage: StageState, time: JulianDate): Cartesian3 | undefined {
    const flight = stage.flight;
    if (flight) {
      const points = this.#linkPositions(stage, time);
      if (points.length < 2) {
        return undefined;
      }
      const { fraction } = flightProgress(flight.startSimMs, JulianDate.toDate(time).getTime(), MIGRATION_ANIMATION_SIM_SECONDS);
      // Along the path by length rather than by leg count, so a relayed packet does
      // not slow down on the long leg and sprint the short one. Lengths are measured
      // live: the legs stretch as the three satellites move.
      const legs = points.slice(1).map((point, at) => Cartesian3.distance(points[at] as Cartesian3, point));
      const total = legs.reduce((sum, leg) => sum + leg, 0);
      let travelled = fraction * total;
      for (let leg = 0; leg < legs.length; leg += 1) {
        const length = legs[leg] as number;
        if (travelled <= length || leg === legs.length - 1) {
          const start = points[leg] as Cartesian3;
          const end = points[leg + 1] as Cartesian3;
          const along = length > 0 ? Math.min(1, travelled / length) : 0;
          const point: Vec3 = lerp({ x: start.x, y: start.y, z: start.z }, { x: end.x, y: end.y, z: end.z }, along);
          return new Cartesian3(point.x, point.y, point.z);
        }
        travelled -= length;
      }
    }
    return this.#positionAt(stage.hostName, time);
  }

  /**
   * What a stage's halo says on the globe.
   *
   * The stage number alone answered "which stage" and left "which satellite"
   * unanswerable from the picture — four identical `S1`…`S4` tags moving over a fleet
   * of twenty. So the label carries the two numbers that place a satellite in the
   * constellation as well: its plane and its slot within that plane, the tag already
   * in the satellite's own name and in the migration tables.
   *
   * While a stage is in flight the label reads `from → to`, because that is the
   * moment the numbers earn their place: the packet is between two satellites and
   * which plane it is crossing into is the thing worth reading. A real catalogued
   * satellite has no plane or slot, so its name stands in.
   */
  #labelText(stage: StageState): string {
    const tag = `S${stage.index + 1}`;
    const named = (host: string | undefined) => planeSlotOf(host) ?? host;
    const flight = stage.flight;
    if (flight) {
      // A relayed hop names every host it passes through: the packet really does go
      // that way round the limb, and which satellites carry it is the thing worth
      // reading off the picture.
      return `${tag} · ${flight.route.hops.map(named).join(" → ")}`;
    }
    if (!stage.hostName) {
      return tag;
    }
    return stage.phase === "stranded" ? `${tag} · ${named(stage.hostName)} · STRANDED` : `${tag} · ${named(stage.hostName)}`;
  }

  /**
   * The four entities drawing one stage, in the order they should be added.
   *
   * Named with the stage number so the entity list is readable and the browser
   * check can find each stage's parts: `Migration host S1`, `Migration link S1`,
   * and so on.
   */
  #buildEntities(stage: StageState): Entity[] {
    const label = `S${stage.index + 1}`;
    const hue = Color.fromCssColorString(stageColor(stage.index));
    const stranded = Color.fromCssColorString(MIGRATION_COLOR.stranded);
    const powered = Color.fromCssColorString(MIGRATION_COLOR.host);
    const packet = Color.fromCssColorString(MIGRATION_COLOR.packet);

    // The satellite running this stage: a translucent halo in the stage's hue,
    // turning red when the model reports the stage stranded (dark host, no free lit
    // neighbour) and green-rimmed while it is powered and serving.
    const host = new Entity({
      name: `Migration host ${label}`,
      position: new CallbackPositionProperty((time?: JulianDate) => this.#positionAt(stage.hostName, time ?? this.#viewer.clock.currentTime), false),
      point: new PointGraphics({
        pixelSize: 22,
        color: new CallbackProperty(() => (stage.phase === "stranded" ? stranded : hue).withAlpha(0.35), false),
        outlineColor: new CallbackProperty(() => (stage.phase === "stranded" ? stranded : this.#status.serving ? powered : hue), false),
        outlineWidth: 2,
      }),
      label: new LabelGraphics({
        text: new CallbackProperty(() => this.#labelText(stage), false),
        font: "12px sans-serif",
        fillColor: Color.WHITE,
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian3(0, -18, 0),
        translucencyByDistance: new NearFarScalar(1e6, 1, 6e7, 0.4),
      }),
    });

    // The inter-satellite link, drawn only while this stage is in flight. Two
    // points for a direct hop, three when it goes through a relay — the bend at
    // the middle host is the Earth being routed around rather than through.
    const link = new Entity({
      name: `Migration link ${label}`,
      polyline: new PolylineGraphics({
        positions: new CallbackProperty((time?: JulianDate) => this.#linkPositions(stage, time ?? this.#viewer.clock.currentTime), false),
        width: 3,
        material: new PolylineGlowMaterialProperty({ glowPower: 0.25, color: hue }),
        // Straight chord, not draped on the globe — see the note above on why
        // this is ArcType.NONE rather than undefined.
        arcType: ArcType.NONE,
      }),
    });

    // The KV cache in flight: a bright point sliding along the link.
    const inFlight = new Entity({
      name: `Migrating KV cache ${label}`,
      position: new CallbackPositionProperty((time?: JulianDate) => this.#packetPosition(stage, time ?? this.#viewer.clock.currentTime), false),
      point: new PointGraphics({
        pixelSize: 12,
        color: packet,
        outlineColor: hue,
        outlineWidth: 2,
        show: new CallbackProperty(() => stage.flight !== undefined, false),
      }),
    });

    // A ring at the destination while a migration is arriving.
    const target = new Entity({
      name: `Migration target ${label}`,
      position: new CallbackPositionProperty((time?: JulianDate) => this.#positionAt(stage.flight?.to, time ?? this.#viewer.clock.currentTime), false),
      point: new PointGraphics({
        pixelSize: 18,
        color: hue.withAlpha(0.2),
        outlineColor: hue,
        outlineWidth: 2,
        show: new CallbackProperty(() => stage.flight !== undefined, false),
      }),
    });

    return [link, target, host, inFlight];
  }
}

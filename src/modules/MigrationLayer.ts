import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian3,
  Color,
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
  DEFAULT_PIPELINE_STAGES,
  ISL_GBPS,
  MAX_SIM_STEP_SECONDS,
  MIGRATION_ANIMATION_MS,
  MIGRATION_COLOR,
  MIGRATION_EVAL_MS,
  MIGRATION_LOG_LENGTH,
  stageColor,
} from "../config/migration";
import type { SatelliteManager } from "./SatelliteManager";
import {
  accrueTime,
  decideStageMigration,
  distanceKm,
  emptyLedger,
  type MigrationEvent,
  type MigrationHost,
  type MigrationLedger,
  lerp,
  placeStages,
  poweredStageCount,
  recordMigration,
  allPoweredFraction,
  transferCost,
  type TransferCost,
  type Vec3,
} from "./util/migration";

/** What one pipeline stage is doing, for the panel's per-stage row. */
export interface MigrationStageStatus {
  /** 0-based position in the pipeline; the panel prints it 1-based. */
  index: number;
  phase: "holding" | "migrating" | "stranded";
  hostName?: string;
  from?: string;
  to?: string;
  linkKm?: number;
  transferSeconds?: number;
  /** Whether this stage's host currently has power. */
  powered: boolean;
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
  /** `migrating` if any stage is in flight, else `stranded` if any is stuck, else `holding`. */
  phase: "holding" | "migrating" | "stranded";
  hostName?: string;
  from?: string;
  to?: string;
  reason: string;
  kvGigabytes: number;
  islGbps: number;
  linkKm?: number;
  transferSeconds?: number;
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
  startWallMs: number;
  cost: TransferCost;
  linkKm: number;
  /** Simulated instant the migration was decided, for the event log. */
  decidedAt: string;
}

/** One stage's live state: where it lives, and whether it is moving. */
interface StageState {
  index: number;
  hostName: string | undefined;
  flight: Flight | undefined;
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

  #stages: StageState[] = [];

  #removeTick: (() => void) | undefined;

  #lastEvalMs = 0;

  #ledger: MigrationLedger = emptyLedger();

  #log: MigrationEvent[] = [];

  /** Simulated time at the previous tick, for accruing served/stalled seconds. */
  #lastSimMs: number | undefined;

  #status: MigrationStatus;

  constructor(viewer: Viewer, sats: SatelliteManager, kvGigabytes: number = DEFAULT_KV_GIGABYTES, stageCount: number = DEFAULT_PIPELINE_STAGES) {
    this.#viewer = viewer;
    this.#sats = sats;
    this.#kvGigabytes = kvGigabytes;
    this.#stageCount = stageCount;
    this.#status = this.#idleStatus();
  }

  get status(): MigrationStatus {
    return this.#status;
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
    this.#buildStages();
    this.#viewer.scene.requestRender();
  }

  #buildStages(): void {
    this.#stages = [];
    for (let index = 0; index < this.#stageCount; index += 1) {
      const stage: StageState = { index, hostName: undefined, flight: undefined, entities: [], phase: "stranded", reason: "Stage is unplaced." };
      stage.entities = this.#buildEntities(stage);
      for (const entity of stage.entities) {
        this.#viewer.entities.add(entity);
      }
      this.#stages.push(stage);
    }
  }

  #teardownStages(): void {
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
    for (const sat of this.#sats.activeSatellites) {
      const position = sat.props.trajectory.position(time);
      const illumination = sat.props.illumination(date, MigrationLayer.AXIS);
      if (!position || !illumination) {
        continue;
      }
      hosts.push({
        name: sat.props.name,
        position: { x: position.x, y: position.y, z: position.z },
        hasPower: illumination.state === "sunlit_on" || illumination.state === "sunlit_edge",
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
    const nowWall = performance.now();
    const time = this.#viewer.clock.currentTime;
    const date = JulianDate.toDate(time);
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

    // Land any in-flight migration whose packet has arrived, on the wall clock.
    for (const stage of this.#stages) {
      const flight = stage.flight;
      if (!flight) {
        continue;
      }
      if ((nowWall - flight.startWallMs) / MIGRATION_ANIMATION_MS >= 1) {
        stage.hostName = flight.to;
        stage.flight = undefined;
        this.#ledger = recordMigration(this.#ledger, this.#kvGigabytes, flight.cost);
        this.#log = [
          { stage: stage.index, from: flight.from, to: flight.to, linkKm: flight.linkKm, transferSeconds: flight.cost.totalSeconds, at: flight.decidedAt },
          ...this.#log,
        ].slice(0, MIGRATION_LOG_LENGTH);
      }
    }

    // Decide only every MIGRATION_EVAL_MS — a migration is a state change a person
    // reads, not a per-frame animation.
    if (nowWall - this.#lastEvalMs >= MIGRATION_EVAL_MS) {
      this.#lastEvalMs = nowWall;
      this.#decideAll(hosts, nowWall, date);
    }

    this.#accrueTime(date, hosts);
    this.#status = this.#composeStatus(hosts);
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
  #decideAll(hosts: readonly MigrationHost[], nowWall: number, date: Date): void {
    for (const stage of this.#stages) {
      if (stage.flight) {
        stage.phase = "migrating";
        stage.reason = `Migrating ${this.#kvGigabytes} GB: ${stage.flight.from} → ${stage.flight.to}.`;
        continue;
      }
      const decision = decideStageMigration(stage.hostName, hosts, this.#takenBySiblings(stage));
      stage.reason = decision.reason;
      if (decision.action === "migrate" && decision.target) {
        const host = hosts.find((candidate) => candidate.name === stage.hostName);
        if (host) {
          const linkKm = distanceKm(host.position, decision.target.position);
          stage.flight = {
            from: host.name,
            to: decision.target.name,
            startWallMs: nowWall,
            cost: transferCost(this.#kvGigabytes, ISL_GBPS, linkKm),
            linkKm,
            decidedAt: date.toISOString(),
          };
          stage.phase = "migrating";
          continue;
        }
      }
      stage.phase = decision.action === "stranded" ? "stranded" : "holding";
    }
  }

  /**
   * Attribute the simulated time since the last tick to serving or stalling.
   *
   * Simulated rather than wall time because the demo runs at 60× or more, so a cost
   * measured in wall seconds would describe the playback rate rather than the
   * orbit. `accrueTime` drops jumps, which is what makes scrubbing the clock safe.
   *
   * Accrued on `#allPowered` rather than on `#serving`: whether a packet is
   * mid-flight is an *animation* state, and the animation's duration is wall-clock
   * anchored (MIGRATION_ANIMATION_MS), so counting flights as stalled here would
   * make the served fraction a function of the clock multiplier — at 4000× a 2.2 s
   * animation swallows 8800 simulated seconds and the fraction collapses to zero.
   * What the ledger measures instead is pure geometry: how much simulated time every
   * stage had power at once. The transfers' real cost is accounted separately, in
   * `transferSeconds`, from the computed link arithmetic rather than from the
   * animation.
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
   * handshake overlap — but the on-screen flight lasts an animation, not the
   * computed 160 ms, so this drives the readout and not the ledger.
   */
  #serving(hosts: readonly MigrationHost[]): boolean {
    return this.#allPowered(hosts) && this.#stages.every((stage) => !stage.flight);
  }

  #composeStatus(hosts: readonly MigrationHost[]): MigrationStatus {
    const stages: MigrationStageStatus[] = this.#stages.map((stage) => ({
      index: stage.index,
      phase: stage.phase,
      hostName: stage.hostName,
      from: stage.flight?.from,
      to: stage.flight?.to,
      linkKm: stage.flight?.linkKm,
      transferSeconds: stage.flight?.cost.totalSeconds,
      powered: hosts.find((host) => host.name === stage.hostName)?.hasPower === true,
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
      phase,
      hostName: lead?.hostName ?? stages[0]?.hostName,
      from: moving?.from,
      to: moving?.to,
      linkKm: moving?.linkKm,
      transferSeconds: moving?.transferSeconds,
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
    const from = this.#positionAt(stage.flight.from, time);
    const to = this.#positionAt(stage.flight.to, time);
    return from && to ? [from, to] : [];
  }

  /** Where `stage`'s packet is: along the link while migrating, else on its host. */
  #packetPosition(stage: StageState, time: JulianDate): Cartesian3 | undefined {
    const flight = stage.flight;
    if (flight) {
      const from = this.#positionAt(flight.from, time);
      const to = this.#positionAt(flight.to, time);
      if (!from || !to) {
        return undefined;
      }
      const fraction = (performance.now() - flight.startWallMs) / MIGRATION_ANIMATION_MS;
      const point: Vec3 = lerp({ x: from.x, y: from.y, z: from.z }, { x: to.x, y: to.y, z: to.z }, fraction);
      return new Cartesian3(point.x, point.y, point.z);
    }
    return this.#positionAt(stage.hostName, time);
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
        text: new CallbackProperty(() => (stage.phase === "stranded" ? `${label} STRANDED` : label), false),
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

    // The inter-satellite link, drawn only while this stage is in flight.
    const link = new Entity({
      name: `Migration link ${label}`,
      polyline: new PolylineGraphics({
        positions: new CallbackProperty((time?: JulianDate) => this.#linkPositions(stage, time ?? this.#viewer.clock.currentTime), false),
        width: 3,
        material: new PolylineGlowMaterialProperty({ glowPower: 0.25, color: hue }),
        // Straight chord between the two satellites, not draped on the globe.
        arcType: undefined,
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

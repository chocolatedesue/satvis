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
import { DEFAULT_KV_GIGABYTES, ISL_GBPS, MIGRATION_ANIMATION_MS, MIGRATION_COLOR, MIGRATION_EVAL_MS } from "../config/migration";
import type { SatelliteManager } from "./SatelliteManager";
import { decideMigration, distanceKm, initialHost, lerp, type MigrationHost, transferCost, type TransferCost, type Vec3 } from "./util/migration";

/**
 * What the panel reads back about the migration in progress. A plain snapshot,
 * recomputed each evaluation, so a polling readout never touches the layer's
 * internals.
 */
export interface MigrationStatus {
  active: boolean;
  phase: "holding" | "migrating" | "stranded";
  hostName?: string;
  from?: string;
  to?: string;
  reason: string;
  kvGigabytes: number;
  islGbps: number;
  linkKm?: number;
  transferSeconds?: number;
  /** Completed migrations since the demo was switched on. */
  migrations: number;
}

interface Flight {
  from: string;
  to: string;
  startWallMs: number;
  cost: TransferCost;
  linkKm: number;
}

/**
 * The naive live-migration overlay: one workload, one link, one moving packet.
 *
 * A scene-level layer rather than a per-satellite component (unlike Orbit or the
 * Illumination arc), because a migration is a *relation between two* satellites,
 * not a property of one — the link and the packet belong to neither endpoint. It
 * owns four entities in the viewer's own collection and drives them from the
 * clock, reading positions live so the link stays glued to two moving satellites
 * and the packet slides between them.
 *
 * The decision logic lives in util/migration.ts and is tested there; this class is
 * the wiring — where the workload is, when a migration starts, and how the four
 * entities render the current state.
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

  #hostName: string | undefined;

  #flight: Flight | undefined;

  #removeTick: (() => void) | undefined;

  #lastEvalMs = 0;

  #migrations = 0;

  #status: MigrationStatus;

  #entities: Entity[] = [];

  #host!: Entity;

  #target!: Entity;

  #link!: Entity;

  #packet!: Entity;

  constructor(viewer: Viewer, sats: SatelliteManager, kvGigabytes: number = DEFAULT_KV_GIGABYTES) {
    this.#viewer = viewer;
    this.#sats = sats;
    this.#kvGigabytes = kvGigabytes;
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
    this.#buildEntities();
    for (const entity of this.#entities) {
      this.#viewer.entities.add(entity);
    }
    // Per clock tick, which is per rendered frame — the packet and link read live
    // positions there, and the decision is throttled inside the handler.
    this.#removeTick = this.#viewer.clock.onTick.addEventListener(() => this.#tick());
    this.#viewer.scene.requestRender();
  }

  stop(): void {
    this.#removeTick?.();
    this.#removeTick = undefined;
    for (const entity of this.#entities) {
      this.#viewer.entities.remove(entity);
    }
    this.#entities = [];
    this.#hostName = undefined;
    this.#flight = undefined;
    this.#migrations = 0;
    this.#status = this.#idleStatus();
    this.#viewer.scene.requestRender();
  }

  #idleStatus(): MigrationStatus {
    return {
      active: false,
      phase: "holding",
      reason: "Migration demo is off.",
      kvGigabytes: this.#kvGigabytes,
      islGbps: ISL_GBPS,
      migrations: 0,
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

  #tick(): void {
    const nowWall = performance.now();
    const time = this.#viewer.clock.currentTime;
    const date = JulianDate.toDate(time);
    const hosts = this.#hostsAt(date, time);

    if (hosts.length < 2) {
      this.#status = { ...this.#idleStatus(), active: true, phase: "stranded", reason: "Waiting for the two-orbit demo — need at least two satellites." };
      return;
    }

    // Adopt a host if there is none, or if the one we had has left the scene.
    if (!this.#hostName || !hosts.some((host) => host.name === this.#hostName)) {
      this.#hostName = initialHost(hosts)?.name;
      this.#flight = undefined;
    }

    // Advance an in-flight migration on the wall clock; land it when the packet
    // arrives. The workload then lives on the target.
    if (this.#flight) {
      const fraction = (nowWall - this.#flight.startWallMs) / MIGRATION_ANIMATION_MS;
      if (fraction >= 1) {
        this.#hostName = this.#flight.to;
        this.#migrations += 1;
        this.#flight = undefined;
      }
    }

    // Decide only when nothing is in flight, and only every MIGRATION_EVAL_MS —
    // a migration is a state change, not a per-frame animation.
    if (!this.#flight && nowWall - this.#lastEvalMs >= MIGRATION_EVAL_MS) {
      this.#lastEvalMs = nowWall;
      const decision = decideMigration(this.#hostName, hosts);
      if (decision.action === "migrate" && decision.target) {
        const host = hosts.find((candidate) => candidate.name === this.#hostName);
        if (host) {
          const linkKm = distanceKm(host.position, decision.target.position);
          this.#flight = {
            from: host.name,
            to: decision.target.name,
            startWallMs: nowWall,
            cost: transferCost(this.#kvGigabytes, ISL_GBPS, linkKm),
            linkKm,
          };
        }
      }
    }

    this.#status = this.#composeStatus(hosts);
    this.#viewer.scene.requestRender();
  }

  #composeStatus(hosts: MigrationHost[]): MigrationStatus {
    const base = { active: true, kvGigabytes: this.#kvGigabytes, islGbps: ISL_GBPS, migrations: this.#migrations };
    if (this.#flight) {
      return {
        ...base,
        phase: "migrating",
        hostName: this.#flight.from,
        from: this.#flight.from,
        to: this.#flight.to,
        linkKm: this.#flight.linkKm,
        transferSeconds: this.#flight.cost.totalSeconds,
        reason: `Migrating KV cache ${this.#kvGigabytes} GB: ${this.#flight.from} → ${this.#flight.to}.`,
      };
    }
    const decision = decideMigration(this.#hostName, hosts);
    if (decision.action === "stranded") {
      return { ...base, phase: "stranded", hostName: this.#hostName, reason: decision.reason };
    }
    return { ...base, phase: "holding", hostName: this.#hostName, reason: decision.reason };
  }

  /** The two-way position of the current link's endpoints, or [] when idle. */
  #linkPositions(time: JulianDate): Cartesian3[] {
    if (!this.#flight) {
      return [];
    }
    const from = this.#positionAt(this.#flight.from, time);
    const to = this.#positionAt(this.#flight.to, time);
    return from && to ? [from, to] : [];
  }

  /** Where the packet is: along the link while migrating, else on its host. */
  #packetPosition(time: JulianDate): Cartesian3 | undefined {
    if (this.#flight) {
      const from = this.#positionAt(this.#flight.from, time);
      const to = this.#positionAt(this.#flight.to, time);
      if (!from || !to) {
        return undefined;
      }
      const fraction = (performance.now() - this.#flight.startWallMs) / MIGRATION_ANIMATION_MS;
      const point: Vec3 = lerp({ x: from.x, y: from.y, z: from.z }, { x: to.x, y: to.y, z: to.z }, fraction);
      return new Cartesian3(point.x, point.y, point.z);
    }
    return this.#positionAt(this.#hostName, time);
  }

  #buildEntities(): void {
    const host = Color.fromCssColorString(MIGRATION_COLOR.host);
    const stranded = Color.fromCssColorString(MIGRATION_COLOR.stranded);
    const link = Color.fromCssColorString(MIGRATION_COLOR.link);
    const packet = Color.fromCssColorString(MIGRATION_COLOR.packet);

    // The satellite doing the compute: a translucent halo that turns red when the
    // model reports the workload stranded (dark host, no lit neighbour).
    this.#host = new Entity({
      name: "Migration host",
      position: new CallbackPositionProperty((time?: JulianDate) => this.#positionAt(this.#hostName, time ?? this.#viewer.clock.currentTime), false),
      point: new PointGraphics({
        pixelSize: 22,
        color: new CallbackProperty(() => (this.#status.phase === "stranded" ? stranded : host).withAlpha(0.35), false),
        outlineColor: new CallbackProperty(() => (this.#status.phase === "stranded" ? stranded : host), false),
        outlineWidth: 2,
      }),
      label: new LabelGraphics({
        text: new CallbackProperty(() => (this.#status.phase === "stranded" ? "STRANDED" : "KV host"), false),
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

    // The inter-satellite link, drawn only while a migration is in flight.
    this.#link = new Entity({
      name: "Migration link",
      polyline: new PolylineGraphics({
        positions: new CallbackProperty((time?: JulianDate) => this.#linkPositions(time ?? this.#viewer.clock.currentTime), false),
        width: 3,
        material: new PolylineGlowMaterialProperty({ glowPower: 0.25, color: link }),
        // Straight chord between the two satellites, not draped on the globe.
        arcType: undefined,
      }),
    });

    // The KV cache in flight: a bright point sliding along the link.
    this.#packet = new Entity({
      name: "Migrating KV cache",
      position: new CallbackPositionProperty((time?: JulianDate) => this.#packetPosition(time ?? this.#viewer.clock.currentTime), false),
      point: new PointGraphics({
        pixelSize: 12,
        color: packet,
        outlineColor: link,
        outlineWidth: 2,
        show: new CallbackProperty(() => this.#flight !== undefined, false),
      }),
    });

    // A ring at the destination while a migration is arriving.
    this.#target = new Entity({
      name: "Migration target",
      position: new CallbackPositionProperty((time?: JulianDate) => this.#positionAt(this.#flight?.to, time ?? this.#viewer.clock.currentTime), false),
      point: new PointGraphics({
        pixelSize: 18,
        color: link.withAlpha(0.2),
        outlineColor: link,
        outlineWidth: 2,
        show: new CallbackProperty(() => this.#flight !== undefined, false),
      }),
    });

    this.#entities = [this.#link, this.#target, this.#host, this.#packet];
  }
}

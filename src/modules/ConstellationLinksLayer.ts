import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian3,
  Color,
  Entity,
  JulianDate,
  LabelGraphics,
  LabelStyle,
  PointGraphics,
  PolylineDashMaterialProperty,
  PolylineGlowMaterialProperty,
  PolylineGraphics,
  VerticalOrigin,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { SatelliteManager } from "./SatelliteManager";
import { constellationLinks, parseWalkerSatellite, resolveMarks, type LinkEndpoint, type SatelliteLink } from "./util/constellationLinks";
import { hasLineOfSight } from "./util/migration";
import { planeSlotOf } from "./util/walkerDelta";

/**
 * The stable-constellation link overlay: every generated Walker satellite on
 * screen wired into the topology scripts/derive-isl-topology.mjs derived —
 * rigid rings inside each plane, same-slot links between planes that rotate
 * the same way, nothing across the Walker Star seam, nothing across shells.
 *
 * The layer is deliberately mechanical: the topology rules live in
 * util/constellationLinks.ts (Cesium-free, tested), and this class only wires
 * the graph to the globe. Two things it does add:
 *
 * - **Live geometry.** Each polyline reads its two endpoints from the
 *   trajectories on every frame, so the inter-plane links visibly breathe as
 *   their planes cross and the whole topology rotates with the fleet — the
 *   "整体的变化" the overlay exists to show.
 * - **Honest occlusion.** A link whose chord passes behind the Earth is hidden
 *   rather than drawn through rock — the same standard util/migration.ts sets
 *   for the migration overlay, checked per link on a slow cadence since the
 *   occlusion state changes far more slowly than the positions do.
 *
 * Real ISL colours would be one hue; two are used because the two families are
 * the story: the intra-plane rings never change length (the derivation measured
 * CV ≈ 0.001), the inter-plane links breathe with the plane geometry (CV
 * ≈ 0.14–0.27) — watching them swell and slacken as planes cross is watching
 * why the same-slot pairing is the design that holds.
 *
 * On top of the auto-topology, a **marked cluster** (`setMarks`) names a small
 * fleet of satellites to watch as a unit: each member carries an amber halo and
 * its plane-slot label, and every marked pair is bonded with an amber link —
 * including pairs the topology rules would never link, which is what makes a
 * cross-shell cluster's slow shear directly observable.
 */
export class ConstellationLinksLayer {
  readonly #viewer: Viewer;

  readonly #sats: SatelliteManager;

  /** One entity per link, keyed by the undirected endpoint pair. */
  readonly #entities = new Map<string, Entity>();

  /** Line-of-sight state per link key, refreshed on the slow cadence. */
  readonly #visible = new Map<string, boolean>();

  /** Signature of the active generated-satellite set the graph was built from. */
  #signature = "";

  /** Marked-cluster tokens, resolved against the active set on every rebuild. */
  #marks: string[] = [];

  /** Halo + label per marked member, keyed by satellite name. */
  readonly #markedEntities = new Map<string, Entity>();

  /** Amber bond per marked pair, keyed by the undirected endpoint pair. */
  readonly #bondEntities = new Map<string, Entity>();

  #removeTick: (() => void) | undefined;

  #lastCheckMs = 0;

  /** Wall-clock cadence for the occlusion pass and the graph-diff, in ms. */
  static readonly CHECK_EVERY_MS = 400;

  static readonly INTRA_COLOR = Color.fromCssColorString("#34d399");

  static readonly INTER_COLOR = Color.fromCssColorString("#a78bfa");

  static readonly MARK_COLOR = Color.fromCssColorString("#fbbf24");

  constructor(viewer: Viewer, sats: SatelliteManager) {
    this.#viewer = viewer;
    this.#sats = sats;
  }

  start(): void {
    if (this.#removeTick) {
      return;
    }
    this.#removeTick = this.#viewer.clock.onTick.addEventListener(() => this.#tick());
    this.#refresh();
    this.#viewer.scene.requestRender();
  }

  stop(): void {
    this.#removeTick?.();
    this.#removeTick = undefined;
    for (const entity of this.#entities.values()) {
      this.#viewer.entities.remove(entity);
    }
    this.#entities.clear();
    this.#visible.clear();
    this.#clearMarks();
    this.#signature = "";
    this.#viewer.scene.requestRender();
  }

  /** Restyle the marked cluster. A new token list replaces the old wholesale. */
  setMarks(marks: string[]): void {
    this.#marks = [...marks];
    if (this.#removeTick) {
      this.#rebuildMarks();
      this.#viewer.scene.requestRender();
    }
  }

  #clearMarks(): void {
    for (const entity of this.#markedEntities.values()) {
      this.#viewer.entities.remove(entity);
    }
    for (const entity of this.#bondEntities.values()) {
      this.#viewer.entities.remove(entity);
    }
    this.#markedEntities.clear();
    this.#bondEntities.clear();
  }

  /**
   * Rebuild the marked cluster's entities from the current tokens and the
   * active generated set. Members that are not currently flying contribute
   * nothing and join later, when the graph next rebuilds with them present.
   */
  #rebuildMarks(): void {
    const endpoints: LinkEndpoint[] = [];
    for (const sat of this.#sats.activeSatellites) {
      const parsed = parseWalkerSatellite(sat.props.name);
      if (parsed) {
        endpoints.push(parsed);
      }
    }
    const { members, bonds } = resolveMarks(this.#marks, endpoints);
    const memberNames = new Set(members.map((member) => member.name));
    for (const [name, entity] of this.#markedEntities) {
      if (!memberNames.has(name)) {
        this.#viewer.entities.remove(entity);
        this.#markedEntities.delete(name);
      }
    }
    const wantedBonds = new Map(bonds.map((bond) => [`${[bond.a, bond.b].toSorted().join("|")}`, bond]));
    for (const [key, entity] of this.#bondEntities) {
      if (!wantedBonds.has(key)) {
        this.#viewer.entities.remove(entity);
        this.#bondEntities.delete(key);
        this.#visible.delete(key);
      }
    }
    const hue = ConstellationLinksLayer.MARK_COLOR;
    for (const member of members) {
      if (this.#markedEntities.has(member.name)) {
        continue;
      }
      // A ring rather than a dot: the satellite's own point stays readable
      // inside it, and the slot label is the handle a viewer tracks.
      const halo = new Entity({
        name: `Marked satellite ${member.name}`,
        position: new CallbackPositionProperty((time?: JulianDate) => this.#positionAt(member.name, time ?? this.#viewer.clock.currentTime) ?? undefined, false),
        point: new PointGraphics({
          pixelSize: 22,
          color: Color.TRANSPARENT,
          outlineColor: hue,
          outlineWidth: 3,
        }),
        label: new LabelGraphics({
          text: planeSlotOf(member.name) ?? member.name,
          font: "13px sans-serif",
          fillColor: hue,
          style: LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian3(0, -18, 0),
        }),
      });
      this.#markedEntities.set(member.name, halo);
      this.#viewer.entities.add(halo);
    }
    for (const [key, bond] of wantedBonds) {
      if (this.#bondEntities.has(key)) {
        continue;
      }
      // Solid for a bond whose members share a period — the distance envelope
      // repeats every orbit and the pair never parts. Dashed for one whose
      // members drift through their synodic cycle without bound. The line
      // style is the stability verdict, so it reads without the panel.
      const entity = new Entity({
        name: `Marked bond ${bond.a} ↔ ${bond.b}${bond.samePeriod ? "" : " (drifting)"}`,
        polyline: new PolylineGraphics({
          positions: new CallbackProperty((time?: JulianDate) => {
            const at = time ?? this.#viewer.clock.currentTime;
            const pa = this.#positionAt(bond.a, at);
            const pb = this.#positionAt(bond.b, at);
            return pa && pb ? [pa, pb] : [];
          }, false),
          width: 3,
          material: bond.samePeriod ? new PolylineGlowMaterialProperty({ glowPower: 0.3, color: hue }) : new PolylineDashMaterialProperty({ color: hue, dashLength: 18 }),
          // Straight chord between the two satellites, not draped on the globe.
          arcType: undefined,
        }),
      });
      this.#bondEntities.set(key, entity);
      this.#viewer.entities.add(entity);
    }
  }

  #positionAt(name: string, time: JulianDate): Cartesian3 | undefined {
    return this.#sats.getSatellite(name)?.props.trajectory.position(time);
  }

  #tick(): void {
    const now = performance.now();
    if (now - this.#lastCheckMs < ConstellationLinksLayer.CHECK_EVERY_MS) {
      return;
    }
    this.#lastCheckMs = now;
    this.#refresh();
    this.#checkOcclusion();
  }

  /** Rebuild the link graph when the active generated-satellite set changed. */
  #refresh(): void {
    const endpoints = [];
    for (const sat of this.#sats.activeSatellites) {
      const parsed = parseWalkerSatellite(sat.props.name);
      if (parsed) {
        endpoints.push(parsed);
      }
    }
    const signature = endpoints
      .map((endpoint) => endpoint.name)
      .toSorted()
      .join("|");
    if (signature === this.#signature) {
      return;
    }
    this.#signature = signature;
    const links = constellationLinks(endpoints);
    const wanted = new Map<string, SatelliteLink>();
    for (const link of links) {
      wanted.set(`${[link.a, link.b].toSorted().join("|")}`, link);
    }
    for (const [key, entity] of this.#entities) {
      if (!wanted.has(key)) {
        this.#viewer.entities.remove(entity);
        this.#entities.delete(key);
        this.#visible.delete(key);
      }
    }
    for (const [key, link] of wanted) {
      if (this.#entities.has(key)) {
        continue;
      }
      const intra = link.kind === "intra";
      const hue = intra ? ConstellationLinksLayer.INTRA_COLOR : ConstellationLinksLayer.INTER_COLOR;
      const entity = new Entity({
        name: `${intra ? "Ring" : "Inter-plane"} link ${link.a} ↔ ${link.b}`,
        polyline: new PolylineGraphics({
          positions: new CallbackProperty((time?: JulianDate) => {
            const at = time ?? this.#viewer.clock.currentTime;
            const a = this.#positionAt(link.a, at);
            const b = this.#positionAt(link.b, at);
            return a && b ? [a, b] : [];
          }, false),
          width: intra ? 1.5 : 2,
          material: new PolylineGlowMaterialProperty({ glowPower: 0.2, color: hue }),
          // Straight chord between the two satellites, not draped on the globe.
          arcType: undefined,
        }),
      });
      this.#entities.set(key, entity);
      this.#viewer.entities.add(entity);
    }
    this.#rebuildMarks();
    // Occlusion state starts unknown: the next pass settles it, and until then
    // the CallbackProperty above still draws the chord.
    this.#checkOcclusion();
    this.#viewer.scene.requestRender();
  }

  /** Hide links whose chord passes behind the Earth. */
  #checkOcclusion(): void {
    const time = this.#viewer.clock.currentTime;
    for (const [key, entity] of this.#entities) {
      const endpoints = key.split("|");
      const a = this.#positionAt(endpoints[0]!, time);
      const b = this.#positionAt(endpoints[1]!, time);
      const seen = a !== undefined && b !== undefined && hasLineOfSight(a, b, 0);
      this.#visible.set(key, seen);
      entity.show = seen;
    }
    for (const [key, entity] of this.#bondEntities) {
      const endpoints = key.split("|");
      const a = this.#positionAt(endpoints[0]!, time);
      const b = this.#positionAt(endpoints[1]!, time);
      entity.show = a !== undefined && b !== undefined && hasLineOfSight(a, b, 0);
    }
  }
}

import { CallbackProperty, Cartesian3, Color, Entity, JulianDate, PolylineGlowMaterialProperty, PolylineGraphics } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { SatelliteManager } from "./SatelliteManager";
import { constellationLinks, parseWalkerSatellite, type SatelliteLink } from "./util/constellationLinks";
import { hasLineOfSight } from "./util/migration";

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

  #removeTick: (() => void) | undefined;

  #lastCheckMs = 0;

  /** Wall-clock cadence for the occlusion pass and the graph-diff, in ms. */
  static readonly CHECK_EVERY_MS = 400;

  static readonly INTRA_COLOR = Color.fromCssColorString("#34d399");

  static readonly INTER_COLOR = Color.fromCssColorString("#a78bfa");

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
    this.#signature = "";
    this.#viewer.scene.requestRender();
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
  }
}

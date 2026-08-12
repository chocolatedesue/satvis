import { BillboardGraphics, Cartesian3, Entity, HeightReference, HorizontalOrigin, JulianDate, NearFarScalar, VerticalOrigin } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import icon from "../images/icons/pin.svg";
import { stationPasses, stationPassesSettled, type Pass } from "./PassPredictor";
import type { SatelliteManager } from "./SatelliteManager";

export interface GroundStationPositionData {
  latitude: number;
  longitude: number;
  height: number;
  cartesian: Cartesian3;
}

/**
 * A named position on the ground, drawn as one pin.
 *
 * One Entity, made once and never rebuilt — which is why this no longer extends
 * CesiumComponentCollection. It had a single component the whole time, so the
 * map of components, the lazy flag, the shared geometry array and the batch
 * rebuilding were all inherited and none of them were ever used.
 */
export class GroundStationEntity {
  readonly #viewer: Viewer;

  readonly #entity: Entity;

  sats: SatelliteManager;

  position: GroundStationPositionData;

  givenName: string;

  constructor(viewer: Viewer, sats: SatelliteManager, position: GroundStationPositionData, givenName: string = "") {
    this.#viewer = viewer;
    this.sats = sats;
    this.position = position;
    this.givenName = givenName;

    const billboard = new BillboardGraphics({
      image: icon,
      horizontalOrigin: HorizontalOrigin.CENTER,
      // The tip of the pin is what marks the spot, and it is the bottom of the
      // artwork.
      verticalOrigin: VerticalOrigin.BOTTOM,
      // The station's own height is 0, so on any real surface the pin was buried
      // by the local elevation — a few hundred metres of it under a photorealistic
      // mesh, where the pin marks the very spot the sky view stands on. Clamped
      // rather than offset, because there is no one height to offset by: the
      // surface may be the ellipsoid, terrain, or a tileset.
      heightReference: HeightReference.CLAMP_TO_GROUND,
      // Scales are a fraction of the source image, so they belong with it: the
      // pin is 96 px square, giving roughly 38 px up close and 21 px from orbit.
      scaleByDistance: new NearFarScalar(1e2, 0.4, 4e7, 0.22),
    });
    this.#entity = new Entity({
      name: this.name,
      position: position.cartesian,
      // Where the camera sits when this is tracked.
      viewFrom: new Cartesian3(0, -3600000, 4200000),
      billboard,
    });
  }

  show(): void {
    if (!this.#viewer.entities.contains(this.#entity)) {
      this.#viewer.entities.add(this.#entity);
    }
  }

  hide(): void {
    this.#viewer.entities.remove(this.#entity);
  }

  get isSelected(): boolean {
    return this.#viewer.selectedEntity === this.#entity;
  }

  get isTracked(): boolean {
    return this.#viewer.trackedEntity === this.#entity;
  }

  track(): void {
    this.#viewer.trackedEntity = this.#entity;
  }

  get hasName(): boolean {
    return this.givenName !== "";
  }

  get name(): string {
    if (this.givenName) {
      return this.givenName;
    }
    return `${this.position.latitude.toFixed(2)}°, ${this.position.longitude.toFixed(2)}°`;
  }

  passes(time: JulianDate, deltaHours = 48): Pass[] {
    return stationPasses(
      this.sats.visibleSatellites.map((sat) => sat.props.passPredictor),
      time,
      this.name,
      deltaHours,
    );
  }

  /** Whether every satellite feeding this station's list has answered yet. */
  passesSettled(time: JulianDate): boolean {
    return stationPassesSettled(
      this.sats.visibleSatellites.map((sat) => sat.props.passPredictor),
      time,
    );
  }
}

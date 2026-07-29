import { BillboardGraphics, type Cartesian3, HorizontalOrigin, JulianDate, NearFarScalar, VerticalOrigin } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import icon from "../images/icons/pin.svg";
import { stationPasses, type Pass } from "./PassPredictor";
import type { SatelliteManager } from "./SatelliteManager";
import { CesiumComponentCollection } from "./util/CesiumComponentCollection";

export interface GroundStationPositionData {
  latitude: number;
  longitude: number;
  height: number;
  cartesian: Cartesian3;
}

export class GroundStationEntity extends CesiumComponentCollection {
  sats: SatelliteManager;

  position: GroundStationPositionData;

  givenName: string;

  constructor(viewer: Viewer, sats: SatelliteManager, position: GroundStationPositionData, givenName: string = "") {
    super(viewer);
    this.sats = sats;
    this.position = position;
    this.givenName = givenName;

    this.createEntities();
  }

  createEntities(): void {
    this.createGroundStation();
  }

  createGroundStation(): void {
    const billboard = new BillboardGraphics({
      image: icon,
      horizontalOrigin: HorizontalOrigin.CENTER,
      // The tip of the pin is what marks the spot, and it is the bottom of the
      // artwork.
      verticalOrigin: VerticalOrigin.BOTTOM,
      // Scales are a fraction of the source image, so they belong with it: the
      // pin is 96 px square, giving roughly 38 px up close and 21 px from orbit.
      scaleByDistance: new NearFarScalar(1e2, 0.4, 4e7, 0.22),
    });
    this.createCesiumEntity("Groundstation", "billboard", billboard, this.name, this.position.cartesian, false);
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
    // Aggregate passes over this station from all visible satellites
    return stationPasses(
      this.sats.visibleSatellites.map((sat) => sat.props.passPredictor),
      time,
      this.name,
      deltaHours,
    );
  }
}

import { BillboardGraphics, type CallbackProperty, type Cartesian3, HorizontalOrigin, JulianDate, NearFarScalar, VerticalOrigin } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import dayjs from "dayjs";

import icon from "../images/icons/dish.svg";
import type { SatelliteManager } from "./SatelliteManager";
import type { Pass } from "./SatelliteProperties";
import { CesiumComponentCollection } from "./util/CesiumComponentCollection";
import { DescriptionHelper } from "./util/DescriptionHelper";

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

  description: CallbackProperty | undefined;

  constructor(viewer: Viewer, sats: SatelliteManager, position: GroundStationPositionData, givenName: string = "") {
    super(viewer);
    this.sats = sats;
    this.position = position;
    this.givenName = givenName;

    this.createEntities();
  }

  createEntities(): void {
    this.createDescription();
    this.createGroundStation();
  }

  createGroundStation(): void {
    const billboard = new BillboardGraphics({
      image: icon,
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.BOTTOM,
      scaleByDistance: new NearFarScalar(1e2, 0.2, 4e7, 0.1),
    });
    this.createCesiumEntity("Groundstation", "billboard", billboard, this.name, this.description, this.position.cartesian, false);
  }

  createDescription(): void {
    this.description = DescriptionHelper.cachedCallbackProperty((time: JulianDate) => {
      const passes = this.passes(time);
      const content = DescriptionHelper.renderGroundstationDescription(time, this.name, this.position, passes, this.sats.overpassMode);
      return content;
    });
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
    let passes: Pass[] = [];
    // Aggregate passes from all visible satellites
    this.sats.visibleSatellites.forEach((sat) => {
      sat.props.updatePasses(this.viewer.clock.currentTime);
      passes.push(...sat.props.passes);
    });

    // Filter passes based on time
    const timeDate = JulianDate.toDate(time);
    passes = passes.filter((pass) => dayjs(pass.start).diff(timeDate, "hours") < deltaHours);

    // Filter passes based on groundstation
    passes = passes.filter((pass) => pass.groundStationName === this.name);

    // Sort passes by time
    passes.sort((a, b) => a.start - b.start);
    return passes;
  }
}

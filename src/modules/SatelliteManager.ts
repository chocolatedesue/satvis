import type { Viewer } from "@cesium/widgets";

import { useSatStore } from "../stores/sat";
import { GroundStationEntity, type GroundStationPositionData } from "./GroundStationEntity";
import { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { CesiumCleanupHelper } from "./util/CesiumCleanupHelper";

interface SerializedGroundStation {
  lat: number;
  lon: number;
  name?: string;
}

export class SatelliteManager {
  #enabledComponents: string[] = ["Point", "Label"];

  #enabledTags: string[] = [];

  #enabledSatellites: string[] = [];

  #groundStations: GroundStationEntity[] = [];

  #overpassMode: string = "elevation";

  viewer: Viewer;

  satellites: SatelliteComponentCollection[] = [];

  availableComponents: string[] = ["Point", "Label", "Orbit", "Orbit track", "Ground track", "Sensor cone", "3D model"];

  pendingTrackedSatellite: string | undefined;

  constructor(viewer: Viewer) {
    this.viewer = viewer;

    this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.trackedSatellite) {
        this.getSatellite(this.trackedSatellite)?.show(this.#enabledComponents);
      }
      useSatStore().trackedSatellite = this.trackedSatellite;
    });
  }

  addFromTleUrls(urlTagList: ReadonlyArray<readonly [string, string[]]>): void {
    // Initiate async download of all TLE URLs and update store afterwards
    const promises = urlTagList.map(([url, tags]) => this.addFromTleUrl(url, tags, false));
    Promise.all(promises).then(() => this.updateStore());
  }

  addFromTleUrl(url: string, tags: string[], updateStore = true): Promise<void> {
    return fetch(url, {
      mode: "no-cors",
    })
      .then((response) => {
        if (!response.ok) {
          throw Error(response.statusText);
        }
        return response;
      })
      .then((response) => response.text())
      .then((data) => {
        const lines = data.split(/\r?\n/);
        // TLE entries are 3 lines each: name, line 1, line 2.
        for (let i = 0; i + 3 <= lines.length; i += 3) {
          const tle = lines.slice(i, i + 3).join("\n");
          if (tle.trim()) {
            this.addFromTle(tle, tags, updateStore);
          }
        }
      })
      .catch((error) => {
        console.log(error);
      });
  }

  addFromTle(tle: string, tags: string[], updateStore = true): void {
    const sat = new SatelliteComponentCollection(this.viewer, tle, tags);
    this.#add(sat);
    if (updateStore) {
      this.updateStore();
    }
  }

  #add(newSat: SatelliteComponentCollection): void {
    const existingSat = this.satellites.find((sat) => sat.props.satnum === newSat.props.satnum && sat.props.name === newSat.props.name);
    if (existingSat) {
      existingSat.props.addTags(newSat.props.tags);
      if (newSat.props.tags.some((tag) => this.#enabledTags.includes(tag))) {
        existingSat.show(this.#enabledComponents);
      }
      return;
    }
    if (this.groundStationAvailable) {
      newSat.groundStations = this.#groundStations;
    }
    // Set overpass mode for newly added satellite
    newSat.props.overpassMode = this.#overpassMode;
    this.satellites.push(newSat);

    if (this.satIsActive(newSat)) {
      newSat.show(this.#enabledComponents);
      if (this.pendingTrackedSatellite === newSat.props.name) {
        this.trackedSatellite = newSat.props.name;
      }
    }
  }

  updateStore(): void {
    const satStore = useSatStore();
    satStore.availableTags = this.tags;
    satStore.availableSatellitesByTag = this.taglist;
  }

  get taglist(): Record<string, string[]> {
    const taglist: Record<string, string[]> = {};
    this.satellites.forEach((sat) => {
      sat.props.tags.forEach((tag) => {
        (taglist[tag] = taglist[tag] || []).push(sat.props.name);
      });
    });
    Object.values(taglist).forEach((tag) => {
      tag.sort();
    });
    return taglist;
  }

  get selectedSatellite(): string {
    const satellite = this.satellites.find((sat) => sat.isSelected);
    return satellite ? satellite.props.name : "";
  }

  get trackedSatellite(): string {
    const satellite = this.satellites.find((sat) => sat.isTracked);
    return satellite ? satellite.props.name : "";
  }

  set trackedSatellite(name: string | undefined) {
    if (!name) {
      if (this.trackedSatellite) {
        this.viewer.trackedEntity = undefined;
      }
      return;
    }
    if (name === this.trackedSatellite) {
      return;
    }

    const sat = this.getSatellite(name);
    if (sat) {
      sat.track();
      this.pendingTrackedSatellite = undefined;
    } else {
      // Satellite does not exist (yet?)
      this.pendingTrackedSatellite = name;
    }
  }

  get visibleSatellites(): SatelliteComponentCollection[] {
    return this.satellites.filter((sat) => sat.created);
  }

  get satelliteNames(): string[] {
    return this.satellites.map((sat) => sat.props.name);
  }

  getSatellite(name: string): SatelliteComponentCollection | undefined {
    return this.satellites.find((sat) => sat.props.name === name);
  }

  get enabledSatellites(): string[] {
    return this.#enabledSatellites;
  }

  set enabledSatellites(newSats: string[]) {
    this.#enabledSatellites = newSats;
    this.showEnabledSatellites();

    const satStore = useSatStore();
    satStore.enabledSatellites = newSats;
  }

  get tags(): string[] {
    const tags = this.satellites.map((sat) => sat.props.tags);
    return [...new Set<string>(([] as string[]).concat(...tags))];
  }

  getSatellitesWithTag(tag: string): SatelliteComponentCollection[] {
    return this.satellites.filter((sat) => sat.props.hasTag(tag));
  }

  /**
   * Returns true if the satellite is enabled by tag or name
   */
  satIsActive(sat: SatelliteComponentCollection): boolean {
    const enabledByTag = this.#enabledTags.some((tag) => sat.props.hasTag(tag));
    const enabledByName = this.#enabledSatellites.includes(sat.props.name);
    return enabledByTag || enabledByName;
  }

  get activeSatellites(): SatelliteComponentCollection[] {
    return this.satellites.filter((sat) => this.satIsActive(sat));
  }

  showEnabledSatellites(): void {
    this.satellites.forEach((sat) => {
      if (this.satIsActive(sat)) {
        sat.show(this.#enabledComponents);
      } else {
        sat.hide();
      }
    });
    if (this.visibleSatellites.length === 0) {
      CesiumCleanupHelper.cleanup(this.viewer);
    }
  }

  get enabledTags(): string[] {
    return this.#enabledTags;
  }

  set enabledTags(newTags: string[]) {
    this.#enabledTags = newTags;
    this.showEnabledSatellites();

    const satStore = useSatStore();
    satStore.enabledTags = newTags;
  }

  get components(): unknown[] {
    const components = this.satellites.map((sat) => sat.components);
    return [...new Set<unknown>(([] as unknown[]).concat(...(components as unknown as unknown[][])))];
  }

  get enabledComponents(): string[] {
    return this.#enabledComponents;
  }

  set enabledComponents(newComponents: string[]) {
    const oldComponents = this.#enabledComponents;
    const add = newComponents.filter((x) => !oldComponents.includes(x));
    const del = oldComponents.filter((x) => !newComponents.includes(x));
    add.forEach((component) => {
      this.enableComponent(component);
    });
    del.forEach((component) => {
      this.disableComponent(component);
    });
  }

  enableComponent(componentName: string): void {
    if (!this.#enabledComponents.includes(componentName)) {
      this.#enabledComponents.push(componentName);
    }

    this.activeSatellites.forEach((sat) => {
      sat.enableComponent(componentName);
    });
  }

  disableComponent(componentName: string): void {
    this.#enabledComponents = this.#enabledComponents.filter((name) => name !== componentName);

    this.activeSatellites.forEach((sat) => {
      sat.disableComponent(componentName);
    });
  }

  get groundStationAvailable(): boolean {
    return this.#groundStations.length > 0;
  }

  focusGroundStation(): void {
    if (this.groundStationAvailable) {
      this.#groundStations[0]?.track();
    }
  }

  createGroundstation(position: GroundStationPositionData, name: string): GroundStationEntity {
    const groundStation = new GroundStationEntity(this.viewer, this, position, name);
    groundStation.show();
    return groundStation;
  }

  addGroundStation(position: GroundStationPositionData, name: string): void {
    if (position.height < 1) {
      position.height = 0;
    }
    const groundStation = this.createGroundstation(position, name);
    this.groundStations = [...this.#groundStations, groundStation];
  }

  get groundStations(): GroundStationEntity[] {
    return this.#groundStations;
  }

  set groundStations(newGroundStations: GroundStationEntity[]) {
    this.#groundStations = newGroundStations;

    // Set groundstation for all satellites
    this.satellites.forEach((sat) => {
      sat.groundStations = this.#groundStations;
    });

    // Update store for url state
    const satStore = useSatStore();
    const serialized: SerializedGroundStation[] = this.#groundStations.map((gs) => ({
      lat: gs.position.latitude,
      lon: gs.position.longitude,
      name: gs.hasName ? gs.name : undefined,
    }));
    satStore.groundStations = serialized;
  }

  get overpassMode(): string {
    return this.#overpassMode;
  }

  set overpassMode(newMode: string) {
    this.#overpassMode = newMode;
    // Update overpass mode for all satellites
    this.satellites.forEach((sat) => {
      sat.props.overpassMode = newMode;
    });
    // Clear and update passes for all satellites with ground stations to force recalculation
    this.satellites.forEach((sat) => {
      if (sat.props.groundStationAvailable) {
        sat.props.clearPasses();
        sat.props.updatePasses(this.viewer.clock.currentTime);
      }
    });
  }

  get pendingUpdate(): boolean {
    return SatelliteComponentCollection.primitivePendingUpdate;
  }
}

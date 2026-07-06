import type { Viewer } from "@cesium/widgets";

import { type SerializedGroundStation, useSatStore } from "../stores/sat";
import { GroundStationEntity, type GroundStationPositionData } from "./GroundStationEntity";
import { activeTargetEntries } from "./satelliteActivation";
import { type CatalogEntry, SatelliteCatalog } from "./SatelliteCatalog";
import { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { CesiumCleanupHelper } from "./util/CesiumCleanupHelper";
import type { GpRecord } from "./util/gp";

export class SatelliteManager {
  #enabledComponents: string[] = ["Point", "Label"];

  #enabledTags: string[] = [];

  #enabledSatellites: string[] = [];

  #disabledSatellites: string[] = [];

  #groundStations: GroundStationEntity[] = [];

  #overpassMode: string = "elevation";

  viewer: Viewer;

  readonly catalog = new SatelliteCatalog();

  // Live collections keyed by catalog entry key. Satellites are instantiated
  // lazily: only entries in the current activation target (see #reconcileActive)
  // have a collection here; everything else stays a plain catalog entry.
  #active = new Map<string, SatelliteComponentCollection>();

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

    // New/changed catalog entries may fall into the current activation target
    // (e.g. URL-enabled names or a pendingTrackedSatellite that arrives once the
    // catalog finishes loading), so bump the revision and reconcile.
    this.catalog.onChange(() => {
      this.#bumpCatalogRevision();
      this.#reconcileActive();
    });
  }

  // Load element sets for all preset sources via the catalog (resolves the GP
  // base once, fetches all in parallel, per-URL errors logged and skipped).
  loadElementSets(sourceTagList: ReadonlyArray<readonly [string, string[]]>): Promise<void> {
    return this.catalog.loadGroups(sourceTagList);
  }

  // Passthrough for custom inline records (e.g. console/testing usage).
  addCustomRecords(records: GpRecord[], tags: string[]): void {
    this.catalog.addRecords(records, tags);
    this.#bumpCatalogRevision();
    this.#reconcileActive();
  }

  // Catalog entries that should currently be instantiated: enabled by tag
  // (minus per-member opt-outs), enabled by name, or the tracked /
  // pending-tracked satellite.
  #activeTargetEntries(): Map<string, CatalogEntry> {
    return activeTargetEntries({
      entries: this.catalog.entries,
      enabledTags: this.#enabledTags,
      enabledSatellites: this.#enabledSatellites,
      disabledSatellites: this.#disabledSatellites,
      trackedName: this.trackedSatellite || undefined,
      pendingTrackedName: this.pendingTrackedSatellite,
    });
  }

  // Reconcile the live #active map against the activation target: dispose
  // collections that are no longer targeted, instantiate the ones that are
  // newly targeted, and resolve a pending track once its satellite exists.
  #reconcileActive(): void {
    const target = this.#activeTargetEntries();

    // Dispose collections no longer in the target.
    for (const [key, sat] of this.#active) {
      if (target.has(key)) {
        continue;
      }
      if (sat.isTracked) {
        // Clear the tracked entity before tearing down its components so Cesium
        // does not keep a dangling trackedEntity reference.
        this.viewer.trackedEntity = undefined;
      }
      sat.dispose();
      this.#active.delete(key);
    }

    // Instantiate collections newly in the target.
    for (const [key, entry] of target) {
      if (this.#active.has(key)) {
        continue;
      }
      const sat = new SatelliteComponentCollection(this.viewer, entry);
      if (this.groundStationAvailable) {
        sat.groundStations = this.#groundStations;
      }
      sat.props.overpassMode = this.#overpassMode;
      sat.show(this.#enabledComponents);
      this.#active.set(key, sat);
    }

    // Resolve a pending track now that the satellite is guaranteed active
    // (whether it was just created above or was already live).
    if (this.pendingTrackedSatellite) {
      const sat = this.getSatellite(this.pendingTrackedSatellite);
      if (sat) {
        sat.track();
        this.pendingTrackedSatellite = undefined;
      }
    }

    if (this.visibleSatellites.length === 0) {
      CesiumCleanupHelper.cleanup(this.viewer);
    }
  }

  // The catalog is deliberately non-reactive; bumping this revision lets the UI
  // recompute catalog-derived views without mirroring entries into Pinia.
  #bumpCatalogRevision(): void {
    useSatStore().catalogRevision += 1;
  }

  get selectedSatellite(): string {
    for (const sat of this.#active.values()) {
      if (sat.isSelected) {
        return sat.props.name;
      }
    }
    return "";
  }

  get trackedSatellite(): string {
    for (const sat of this.#active.values()) {
      if (sat.isTracked) {
        return sat.props.name;
      }
    }
    return "";
  }

  set trackedSatellite(name: string | undefined) {
    if (!name) {
      if (this.trackedSatellite) {
        this.viewer.trackedEntity = undefined;
      }
      this.pendingTrackedSatellite = undefined;
      // Dispose a satellite that was kept alive only by tracking.
      this.#reconcileActive();
      return;
    }
    if (name === this.trackedSatellite) {
      return;
    }

    // Ensure the satellite is instantiated (tracking alone keeps it alive) and
    // track it. If the name is unknown to the catalog (yet?), reconciling is a
    // no-op and the pending name survives until a matching entry is loaded.
    this.pendingTrackedSatellite = name;
    this.#reconcileActive();
  }

  // Active collections that have created components (i.e. are visible).
  get visibleSatellites(): SatelliteComponentCollection[] {
    return [...this.#active.values()].filter((sat) => sat.created);
  }

  // Active-only lookup. In-repo callers (InfoBoxController, CesiumController,
  // GroundStationEntity) only pass selected/tracked/active names; console users
  // wanting arbitrary lookups should use `cc.sats.catalog.getByName`.
  getSatellite(name: string): SatelliteComponentCollection | undefined {
    for (const sat of this.#active.values()) {
      if (sat.props.name === name) {
        return sat;
      }
    }
    return undefined;
  }

  get enabledSatellites(): string[] {
    return this.#enabledSatellites;
  }

  set enabledSatellites(newSats: string[]) {
    this.#enabledSatellites = newSats;

    const satStore = useSatStore();
    satStore.enabledSatellites = newSats;

    this.#reconcileActive();
  }

  get disabledSatellites(): string[] {
    return this.#disabledSatellites;
  }

  // Names opted out of tag-activation (see satelliteActivation.ts).
  set disabledSatellites(newSats: string[]) {
    this.#disabledSatellites = newSats;

    const satStore = useSatStore();
    satStore.disabledSatellites = newSats;

    this.#reconcileActive();
  }

  get activeSatellites(): SatelliteComponentCollection[] {
    return [...this.#active.values()];
  }

  get enabledTags(): string[] {
    return this.#enabledTags;
  }

  set enabledTags(newTags: string[]) {
    this.#enabledTags = newTags;

    const satStore = useSatStore();
    satStore.enabledTags = newTags;

    this.#reconcileActive();
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

    // Set groundstation for all active satellites
    this.activeSatellites.forEach((sat) => {
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
    this.activeSatellites.forEach((sat) => {
      sat.props.overpassMode = newMode;
      // Clear and update passes when a ground station is set to force recalculation
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

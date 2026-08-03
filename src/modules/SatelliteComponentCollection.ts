import {
  ArcType,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CornerType,
  CorridorGraphics,
  DistanceDisplayCondition,
  Entity,
  EntityView,
  GeometryInstance,
  HeadingPitchRange,
  HeadingPitchRoll,
  HeightReference,
  HorizontalOrigin,
  JulianDate,
  LabelGraphics,
  LabelStyle,
  Math as CesiumMath,
  ModelGraphics,
  NearFarScalar,
  PathGraphics,
  PointGraphics,
  PolylineColorAppearance,
  PolylineGeometry,
  PolylineGlowMaterialProperty,
  PolylineGraphics,
  SceneMode,
  Transforms,
  VelocityOrientationProperty,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import CesiumSensorVolumes from "cesium-sensor-volumes";

import { SATELLITE_COMPONENTS } from "../config/components";
import { ORBIT_CLASS_COLOR, type OrbitClass } from "../config/orbitClass";
import type { GroundStation } from "./PassPredictor";
import type { CatalogEntry } from "./SatelliteCatalog";
import { coneDescription, groundTrackDescription, modelUri, orbitPathTimes, orbitTrackTimes, orbitUsesPathGraphic } from "./satelliteGraphics";
import { SatelliteProperties } from "./SatelliteProperties";
import { CesiumTimelineHelper } from "./util/CesiumTimelineHelper";
import type { PolylineBatch } from "./util/PolylineBatch";

type SatelliteComponentName = string;

/** The shared polyline batches a satellite draws its orbit lines into. */
export interface SatelliteBatches {
  /** Inertial: the Orbit component's closed ellipse. */
  orbits: PolylineBatch;
  /** Fixed: the Orbit track component's Earth-relative path. */
  tracks: PolylineBatch;
}

/**
 * The link drawn to a ground station during a pass. Not in SATELLITE_COMPONENTS
 * and not switchable: the ground-station setter makes it when there is a station
 * to draw to, so it is a component this class creates for itself.
 */
const GROUND_STATION_LINK = "Ground station link";

// The palette converted once, not per satellite: with ~10,000 points on screen
// these are shared instances, the same way Cesium shares its own Color constants.
const POINT_COLOR = Object.fromEntries(Object.entries(ORBIT_CLASS_COLOR).map(([orbitClass, hex]) => [orbitClass, Color.fromCssColorString(hex)])) as Record<OrbitClass, Color>;

/**
 * How each component is made. Keyed against the config list rather than written
 * out as a switch, so adding a component there without a creator here is a
 * compile error instead of a "Unknown component" at runtime.
 */
const CREATORS: Record<(typeof SATELLITE_COMPONENTS)[number] | typeof GROUND_STATION_LINK, (sat: SatelliteComponentCollection) => void> = {
  Point: (sat) => sat.createPoint(),
  Label: (sat) => sat.createLabel(),
  Orbit: (sat) => sat.createOrbit(),
  "Orbit track": (sat) => sat.createOrbitTrack(),
  "Ground track": (sat) => sat.createGroundTrack(),
  "Sensor cone": (sat) => sat.createCone(),
  "3D model": (sat) => sat.createModel(),
  [GROUND_STATION_LINK]: (sat) => sat.createGroundStationLink(),
};

/**
 * An Entity when the component is drawn on its own, a GeometryInstance when it is
 * merged into the shared orbit batch. Never a Primitive: the one creator that made
 * one was dead code, and the branch checking for it could never be true.
 */
type Component = Entity | GeometryInstance;

/** One satellite's Cesium objects, created on demand and dropped on disable. */
export class SatelliteComponentCollection {
  readonly viewer: Viewer;

  readonly props: SatelliteProperties;

  /**
   * The batches every untracked orbit and orbit track are drawn into. Passed in
   * rather than reached for: they are shared by every satellite, and one owner
   * beats a static.
   */
  readonly #orbits: PolylineBatch;

  readonly #tracks: PolylineBatch;

  #components: Record<string, Component> = {};

  /** What a click or a track acts on — the first Entity to be created. */
  defaultEntity: Entity | undefined;

  eventListeners: Record<string, () => void> = {};

  constructor(viewer: Viewer, entry: CatalogEntry, batches: SatelliteBatches) {
    this.viewer = viewer;
    this.props = new SatelliteProperties(entry);
    this.#orbits = batches.orbits;
    this.#tracks = batches.tracks;
  }

  /** Which batch a given component's geometry belongs to. */
  #batchFor(name: SatelliteComponentName): PolylineBatch {
    return name === "Orbit track" ? this.#tracks : this.#orbits;
  }

  get components(): Record<string, Component> {
    return this.#components;
  }

  get componentNames(): string[] {
    return Object.keys(this.#components);
  }

  get created(): boolean {
    return this.componentNames.length > 0;
  }

  get isSelected(): boolean {
    return Object.values(this.#components).some((component) => this.viewer.selectedEntity === component);
  }

  get isTracked(): boolean {
    return Object.values(this.#components).some((component) => this.viewer.trackedEntity === component);
  }

  show(componentNames: string[] = this.componentNames): void {
    componentNames.forEach((name) => this.enableComponent(name));
  }

  hide(componentNames: string[] = this.componentNames): void {
    componentNames.forEach((name) => this.disableComponent(name));
  }

  track(animate = false): void {
    if (!this.defaultEntity) {
      return;
    }
    if (!animate) {
      this.viewer.trackedEntity = this.defaultEntity;
      return;
    }

    this.viewer.trackedEntity = undefined;
    const clockRunning = this.viewer.clock.shouldAnimate;
    this.viewer.clock.shouldAnimate = false;
    void this.viewer.flyTo(this.defaultEntity, { offset: new HeadingPitchRange(0, -CesiumMath.PI_OVER_FOUR, 1580000) }).then((result: boolean) => {
      if (result) {
        this.viewer.trackedEntity = this.defaultEntity;
        this.viewer.clock.shouldAnimate = clockRunning;
      }
    });
  }

  /**
   * Drive the camera from the entity's own position while it is tracked, and put
   * it back to a sensible angle when tracking stops.
   */
  artificiallyTrack(): void {
    const entity = this.defaultEntity;
    if (!entity) {
      return;
    }
    const cameraTracker = new EntityView(entity, this.viewer.scene, this.viewer.scene.globe.ellipsoid);
    const removeTick = this.viewer.clock.onTick.addEventListener((clock) => {
      cameraTracker.update(clock.currentTime);
    });
    const removeTracked = this.viewer.trackedEntityChanged.addEventListener(() => {
      removeTick();
      removeTracked();
      if (typeof this.viewer.trackedEntity === "undefined") {
        void this.viewer.flyTo(entity, { offset: new HeadingPitchRange(0, CesiumMath.toRadians(-90.0), 2000000) });
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCesiumEntity(componentName: string, entityKey: string, entityValue: any, name: string, position: any, moving: boolean): void {
    const entity = new Entity({
      name,
      position,
      viewFrom: new Cartesian3(0, -3600000, 4200000),
    });
    if (moving) {
      entity.orientation = new VelocityOrientationProperty(position);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entity as any)[entityKey] = entityValue;
    this.#components[componentName] = entity;
  }

  enableComponent(name: SatelliteComponentName): void {
    if (!this.created) {
      this.init();
    }
    if (!this.props.trajectory.valid) {
      console.error(`No valid position data available for ${this.props.name}`);
      return;
    }
    if (!(name in this.#components)) {
      this.createComponent(name);
      this.updatedSampledPositionForComponents();
    }

    const component = this.#components[name];
    if (component instanceof Entity) {
      if (!this.viewer.entities.contains(component)) {
        this.viewer.entities.add(component);
      }
      this.defaultEntity ??= component;
    } else if (component instanceof GeometryInstance) {
      this.#batchFor(name).add(component);
    }

    if (name === "3D model") {
      // Adjust label offset to avoid overlap with model
      this.#setLabelOffset(20);
    }
  }

  disableComponent(name: SatelliteComponentName): void {
    if (name === "3D model") {
      // Restore old label offset
      this.#setLabelOffset(10);
    }

    const component = this.#components[name];
    if (component instanceof Entity) {
      this.viewer.entities.remove(component);
    } else if (component instanceof GeometryInstance) {
      this.#batchFor(name).remove(component);
    }
    delete this.#components[name];

    if (this.defaultEntity === component) {
      // Hand the role to whatever is still drawn. It used to be kept pointing at
      // the removed entity, so a click target and the camera's tracked entity
      // could both outlive what they referred to.
      this.defaultEntity = Object.values(this.#components).find((remaining) => remaining instanceof Entity);
    }

    if (this.componentNames.length === 0) {
      // Remove event listeners when no components are enabled
      this.deinit();
    }
  }

  #setLabelOffset(x: number): void {
    const labelEntity = this.#components.Label as Entity | undefined;
    if (labelEntity?.label) {
      labelEntity.label.pixelOffset = new Cartesian2(x, 0) as unknown as typeof labelEntity.label.pixelOffset;
    }
  }

  init(): void {
    this.eventListeners.sampledPosition = this.props.trajectory.start(this.viewer, () => {
      this.updatedSampledPositionForComponents(true);
    });

    // Set up event listeners
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.eventListeners.selectedEntity = this.viewer.selectedEntityChanged.addEventListener((entity: any) => {
      if (!entity || entity?.name === "Ground station") {
        CesiumTimelineHelper.clearHighlightRanges(this.viewer);
        return;
      }
      if (this.isSelected) {
        const passes = this.props.passPredictor.passes(this.viewer.clock.currentTime);
        CesiumTimelineHelper.updateHighlightRanges(this.viewer, passes);
      }
    });

    this.eventListeners.trackedEntity = this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.isTracked) {
        this.artificiallyTrack();
      }
      if ("Orbit" in this.components && !this.isCorrectOrbitComponent()) {
        // Recreate Orbit to change visualisation type
        this.disableComponent("Orbit");
        this.enableComponent("Orbit");
      }
      if ("Orbit track" in this.components && !this.isCorrectOrbitTrackComponent()) {
        // Same swap as the Orbit above: the satellite the camera is on gets the
        // exact per-frame path, everything else gets the batch.
        this.disableComponent("Orbit track");
        this.enableComponent("Orbit track");
      }
    });
  }

  deinit(): void {
    // Remove event listeners
    this.eventListeners.sampledPosition?.();
    this.eventListeners.selectedEntity?.();
    this.eventListeners.trackedEntity?.();
    this.eventListeners = {};
  }

  /**
   * Fully tear down this collection so it can be dropped from the active set.
   *
   * `hide()` disables every created component; removing the last one triggers
   * `deinit()` (see disableComponent), which detaches the sampledPosition and
   * viewer listeners and tears down the sampledPosition. For a collection whose
   * components were never created this is a no-op (empty componentNames), so
   * dispose is safe to call unconditionally and is idempotent.
   */
  dispose(): void {
    this.hide();
  }

  updatedSampledPositionForComponents(update = false): void {
    const { fixed } = this.props.trajectory;
    // Not the inertial frame: it is absent unless an Orbit asked for it, and
    // requiring it here would have stopped every other component updating in
    // exactly the scenes this laziness exists to make cheaper.
    if (!fixed) return;

    Object.entries(this.components).forEach(([type, component]) => {
      if (type === "Orbit") {
        if (component instanceof Entity) {
          // An Orbit exists, so createOrbit has already required the frame.
          this.props.trajectory.requireInertial();
          component.position = this.props.trajectory.inertial;
        } else if (update && component instanceof GeometryInstance) {
          // A geometry cannot be edited in place; it has to be rebuilt
          this.disableComponent("Orbit");
          this.enableComponent("Orbit");
        }
      } else if (type === "Orbit track") {
        if (component instanceof Entity) {
          component.position = fixed;
        } else if (update) {
          // The window it was cut from has just moved, so the samples behind the
          // batched geometry are the old ones. Re-cut rather than rebuild the
          // membership: replace() leaves the batch the same size.
          this.refreshOrbitTrack(this.viewer.clock.currentTime);
        }
      } else if (component instanceof Entity) {
        if (type === "Sensor cone") {
          component.position = fixed;
          component.orientation = new CallbackProperty((time?: JulianDate) => {
            const position = this.props.trajectory.position(time as JulianDate);
            const hpr = new HeadingPitchRoll(0, CesiumMath.toRadians(180), 0);
            return Transforms.headingPitchRollQuaternion(position as Cartesian3, hpr);
          }, false);
        } else {
          component.position = fixed;
          component.orientation = new VelocityOrientationProperty(fixed);
        }
      }
    });
    // Request a single frame after satellite position updates when the clock is paused
    if (!this.viewer.clock.shouldAnimate) {
      const removeCallback = this.viewer.clock.onTick.addEventListener(() => {
        this.viewer.scene.requestRender();
        removeCallback();
      });
    }
  }

  createComponent(name: SatelliteComponentName): void {
    // A plain string, because that is what the store and the url carry. The
    // table's own type is the const union, so a component added to the config
    // without a creator here is still a compile error.
    const create = (CREATORS as Record<string, ((sat: SatelliteComponentCollection) => void) | undefined>)[name];
    if (!create) {
      console.error(`Unknown component ${name}`);
      return;
    }
    create(this);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCesiumSatelliteEntity(entityName: string, entityKey: string, entityValue: any): void {
    this.createCesiumEntity(entityName, entityKey, entityValue, this.props.name, this.props.trajectory.fixed, true);
  }

  // Coloured by orbit regime, matching the badge the satellite browser shows on
  // the same satellite's row — so the menu reads as the legend for the globe.
  //
  // Small on purpose: a whole constellation at 6 px merges into a sheet that
  // hides the globe under it. 5 px still leaves the globe legible under a full
  // Starlink activation, and the outline is what keeps a point visible against
  // bright imagery rather than its size.
  createPoint(): void {
    const point = new PointGraphics({
      pixelSize: 5,
      color: POINT_COLOR[this.props.orbitClass],
      outlineColor: Color.DIMGREY,
      outlineWidth: 1,
    });
    this.createCesiumSatelliteEntity("Point", "point", point);
  }

  createModel(): void {
    const model = new ModelGraphics({
      uri: modelUri(this.props.name, this.props.entry.metadata.modelUrl),
      minimumPixelSize: 50,
      maximumScale: 10000,
    });
    this.createCesiumSatelliteEntity("3D model", "model", model);
  }

  // Drawn in the neutral the LEO point uses, not white: a label is chrome next
  // to the marker it names, and at white it outshouted the very points it was
  // meant to identify.
  createLabel(): void {
    const label = new LabelGraphics({
      text: this.props.name,
      font: "13px Arial",
      fillColor: POINT_COLOR.LEO,
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineColor: Color.DIMGREY,
      outlineWidth: 2,
      horizontalOrigin: HorizontalOrigin.LEFT,
      pixelOffset: new Cartesian2(10, 0),
      distanceDisplayCondition: new DistanceDisplayCondition(2000, 8e7),
      translucencyByDistance: new NearFarScalar(6e7, 1.0, 8e7, 0.0),
    });
    this.createCesiumSatelliteEntity("Label", "label", label);
  }

  createOrbit(): void {
    // The Orbit is the only component drawn in the inertial frame, so it is the
    // only thing that makes the second sample set worth keeping. Declared here,
    // once, rather than at each of the two places below that go on to read it.
    this.props.trajectory.requireInertial();
    if (this.usePathGraphicForOrbit) {
      this.createOrbitPath();
    } else {
      this.createOrbitPolylineGeometry();
    }
  }

  /**
   * Whether the Orbit component matches how it should currently be drawn.
   *
   * The non-path branch used to be checked against `Primitive`, which is what
   * the never-called `createOrbitPolylinePrimitive` would have stored —
   * `createOrbitPolylineGeometry` stores a GeometryInstance, so the check was
   * permanently false and every track change tore down and rebuilt the orbit of
   * every untracked satellite in 3D, each rebuild costing a full batch rebuild.
   */
  isCorrectOrbitComponent(): boolean {
    return this.usePathGraphicForOrbit ? this.components.Orbit instanceof Entity : this.components.Orbit instanceof GeometryInstance;
  }

  get usePathGraphicForOrbit(): boolean {
    return orbitUsesPathGraphic(this.isTracked, this.viewer.scene.mode === SceneMode.SCENE3D);
  }

  createOrbitPath(): void {
    const path = new PathGraphics({
      ...orbitPathTimes(this.props.orbit.orbitalPeriod),
      material: Color.WHITE.withAlpha(0.15),
      resolution: 600,
      width: 2,
    });
    this.createCesiumEntity("Orbit", "path", path, this.props.name, this.props.trajectory.inertial, true);
  }

  /** The orbit as a geometry for the shared batch — how every untracked orbit is drawn in 3D. */
  createOrbitPolylineGeometry(): void {
    const geometryInstance = new GeometryInstance({
      geometry: new PolylineGeometry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        positions: this.props.trajectory.positionsForNextOrbit(this.viewer.clock.currentTime) as any,
        width: 2,
        arcType: ArcType.NONE,
        vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(new Color(1.0, 1.0, 1.0, 0.15)),
      },
      id: this.props.name,
    });
    this.components.Orbit = geometryInstance;
  }

  createOrbitTrack(): void {
    if (this.usePathGraphicForOrbitTrack) {
      this.createOrbitTrackPath();
    } else {
      this.createOrbitTrackPolylineGeometry();
    }
  }

  /**
   * Whether the Orbit track is currently drawn the way it should be — the same
   * question `isCorrectOrbitComponent` asks of the Orbit, and for the same
   * reason: tracking a satellite changes the answer, so the track has to be torn
   * down and rebuilt when it does.
   */
  isCorrectOrbitTrackComponent(): boolean {
    return this.usePathGraphicForOrbitTrack ? this.components["Orbit track"] instanceof Entity : this.components["Orbit track"] instanceof GeometryInstance;
  }

  get usePathGraphicForOrbitTrack(): boolean {
    return orbitUsesPathGraphic(this.isTracked, this.viewer.scene.mode === SceneMode.SCENE3D);
  }

  /**
   * The exact track, resampled every frame by Cesium's PathVisualizer.
   *
   * Reserved for the tracked satellite, which is the one the camera is sitting
   * on and the only one whose head anyone can see move. It costs about 60 µs a
   * frame — irrelevant for one satellite, and 300 ms at five thousand, which is
   * what the batch below exists to avoid.
   */
  createOrbitTrackPath(): void {
    const path = new PathGraphics({
      ...orbitTrackTimes(this.props.orbit.orbitalPeriod),
      material: Color.GOLD.withAlpha(0.15),
      resolution: 600,
      width: 2,
    });
    this.createCesiumSatelliteEntity("Orbit track", "path", path);
  }

  /** The track as a geometry for the shared batch — how every untracked track is drawn in 3D. */
  createOrbitTrackPolylineGeometry(): void {
    this.components["Orbit track"] = this.#orbitTrackGeometry(this.viewer.clock.currentTime);
  }

  #orbitTrackGeometry(time: JulianDate): GeometryInstance {
    return new GeometryInstance({
      geometry: new PolylineGeometry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        positions: this.props.trajectory.positionsForTrack(time) as any,
        width: 2,
        arcType: ArcType.NONE,
        vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(Color.GOLD.withAlpha(0.15)),
      },
      id: this.props.name,
    });
  }

  /**
   * Re-cut the batched track so its head sits back on the satellite.
   *
   * A fixed-frame track goes stale as the clock runs — the satellite advances
   * along a line that does not move with it — so unlike the inertial orbit there
   * is no model matrix that keeps it current and the geometry has to be rebuilt.
   * Cheap enough to do on a timer because the batch coalesces: five thousand
   * calls to `replace` cost one primitive rebuild, not five thousand.
   *
   * A no-op for the tracked satellite, whose track is a PathGraphic that Cesium
   * already keeps exact, and for anything not currently in the batch.
   */
  refreshOrbitTrack(time: JulianDate): void {
    const current = this.#components["Orbit track"];
    if (!(current instanceof GeometryInstance)) {
      return;
    }
    const next = this.#orbitTrackGeometry(time);
    if (this.#tracks.replace(current, next)) {
      this.#components["Orbit track"] = next;
    }
  }

  /**
   * The swath corridor under the satellite, as *constant* positions re-assigned
   * on a timer rather than a CallbackProperty read every frame.
   *
   * A CallbackProperty that reports itself non-constant puts the corridor on
   * Cesium's dynamic-geometry path, and that path re-tessellates the geometry
   * and recreates its ground primitive every single frame — for every satellite
   * that has one. Measured at about 90 µs per drawn corridor per frame, which is
   * 414 ms of main thread at five thousand satellites, and it bought nothing:
   * the callback returns two positions 300 s apart, so the shape it was rebuilt
   * from barely moved between one frame and the next.
   *
   * Constant positions put it back on the static path, where the geometry is
   * only rebuilt when the property actually changes — which is now `refreshGroundTrack`,
   * on the same schedule as the batched orbit tracks.
   */
  createGroundTrack(): void {
    const description = groundTrackDescription(this.props.orbitClass, this.props.swath);
    if (!description) {
      // Ground track unavailable for non-LEO satellites
      return;
    }
    const corridor = new CorridorGraphics({
      cornerType: CornerType.MITERED,
      height: 1000,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      material: Color.DARKRED.withAlpha(0.25),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      positions: this.#groundTrackPositions(this.viewer.clock.currentTime) as any,
      width: description.widthMeters,
    });
    this.createCesiumSatelliteEntity("Ground track", "corridor", corridor);
  }

  /**
   * Undefined entries are dropped rather than passed on: the sampled position
   * has no value outside its window, and a corridor handed a hole in its
   * positions throws from inside Cesium's geometry worker.
   */
  #groundTrackPositions(time: JulianDate): Cartesian3[] {
    return this.props.trajectory.groundTrack(time).filter((position): position is Cartesian3 => position !== undefined);
  }

  /** Advance the swath corridor to `time`. See createGroundTrack. */
  refreshGroundTrack(time: JulianDate): void {
    const entity = this.#components["Ground track"];
    if (!(entity instanceof Entity) || !entity.corridor) {
      return;
    }
    const positions = this.#groundTrackPositions(time);
    if (positions.length < 2) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entity.corridor.positions = positions as any;
  }

  createCone(fov = this.props.coneFovDeg): void {
    const description = coneDescription(this.props.orbitClass, fov);
    if (!description) {
      // Cone graphic unavailable for non-LEO satellites
      return;
    }
    const entity = new Entity();
    entity.addProperty("conicSensor");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entity as any).conicSensor = new CesiumSensorVolumes.ConicSensorGraphics({
      radius: description.radiusMeters,
      innerHalfAngle: description.innerHalfAngleRad,
      outerHalfAngle: description.outerHalfAngleRad,
      lateralSurfaceMaterial: Color.GOLD.withAlpha(0.15),
      intersectionColor: Color.GOLD.withAlpha(0.3),
      intersectionWidth: 1,
    });
    this.components["Sensor cone"] = entity;
  }

  createGroundStationLink(): void {
    if (!this.props.passPredictor.groundStationAvailable) {
      return;
    }
    const polyline = new PolylineGraphics({
      material: new PolylineGlowMaterialProperty({
        glowPower: 0.5,
        color: Color.FORESTGREEN,
      }),
      positions: new CallbackProperty((time?: JulianDate) => {
        const satPosition = this.props.trajectory.position(time as JulianDate);
        const groundPosition = this.activeGroundStationCartesian(time as JulianDate);
        return [satPosition, groundPosition];
      }, false),
      show: new CallbackProperty((time?: JulianDate) => this.props.passPredictor.passIntervals.contains(time as JulianDate), false),
      width: 5,
    });
    this.createCesiumSatelliteEntity("Ground station link", "polyline", polyline);
  }

  /**
   * Resolve the cartesian endpoint for the ground-station link at the given time.
   *
   * The polyline is only shown during a pass (see `show` callback), so we find the
   * pass that contains `time` and look up the ground station that recorded it.
   * Falls back to the first ground station if no active pass is found (e.g. when
   * Cesium evaluates the positions callback outside of any pass interval).
   */
  private activeGroundStationCartesian(time: JulianDate): Cartesian3 | undefined {
    const groundStations = this.props.passPredictor.groundStations;
    if (groundStations.length === 0) {
      return undefined;
    }
    const timeMs = JulianDate.toDate(time).getTime();
    const activePass = this.props.passPredictor.passes(time).find((pass) => timeMs >= pass.start && timeMs <= pass.end);
    const target = (activePass && groundStations.find((gs) => gs.name === activePass.groundStationName)) ?? groundStations[0];
    if (!target) {
      return undefined;
    }
    return Cartesian3.fromDegrees(target.position.longitude, target.position.latitude, target.position.height);
  }

  set groundStations(groundStations: GroundStation[]) {
    // No groundstation calculation for GEO satellites
    if (this.props.orbit.orbitalPeriod > 60 * 12) {
      return;
    }

    // The setter clears the predictor's window; recompute eagerly for the
    // selected/tracked satellite so pass-dependent visuals update immediately.
    this.props.passPredictor.groundStations = groundStations;
    if (this.isSelected || this.isTracked) {
      const passes = this.props.passPredictor.passes(this.viewer.clock.currentTime);
      if (this.isSelected) {
        CesiumTimelineHelper.updateHighlightRanges(this.viewer, passes);
      }
    }
    if (this.created) {
      this.createGroundStationLink();
    }
  }
}

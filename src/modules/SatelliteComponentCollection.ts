import {
  ArcType,
  BoxGraphics,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CornerType,
  CorridorGraphics,
  DistanceDisplayCondition,
  Entity,
  GeometryInstance,
  HeadingPitchRoll,
  HeightReference,
  HorizontalOrigin,
  JulianDate,
  LabelGraphics,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  ModelGraphics,
  NearFarScalar,
  PathGraphics,
  PointGraphics,
  PolylineColorAppearance,
  PolylineGeometry,
  PolylineGlowMaterialProperty,
  PolylineGraphics,
  Primitive,
  SceneMode,
  Transforms,
  VelocityOrientationProperty,
  defined,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import CesiumSensorVolumes from "cesium-sensor-volumes";

import { SatelliteProperties, type GroundStation } from "./SatelliteProperties";
import { CesiumCallbackHelper } from "./util/CesiumCallbackHelper";
import { CesiumComponentCollection } from "./util/CesiumComponentCollection";
import { CesiumTimelineHelper } from "./util/CesiumTimelineHelper";
import { DescriptionHelper } from "./util/DescriptionHelper";

type SatelliteComponentName = string;

export class SatelliteComponentCollection extends CesiumComponentCollection {
  props: SatelliteProperties;

  eventListeners: Record<string, () => void> = {};

  orbitPrimitiveUpdater: (() => void) | undefined;

  static geometryPrimitiveUpdater: (() => void) | undefined;

  description: CallbackProperty | undefined;

  constructor(viewer: Viewer, tle: string, tags: string[]) {
    super(viewer);
    this.props = new SatelliteProperties(tle, tags);
  }

  override enableComponent(name: SatelliteComponentName): void {
    if (!this.created) {
      this.init();
    }
    if (!this.props.sampledPosition?.valid) {
      console.error(`No valid position data available for ${this.props.name}`);
      return;
    }
    if (!(name in this.components)) {
      this.createComponent(name);
      this.updatedSampledPositionForComponents();
    }

    super.enableComponent(name);

    if (name === "3D model") {
      // Adjust label offset to avoid overlap with model
      const labelEntity = this.components.Label as Entity | undefined;
      if (labelEntity?.label) {
        labelEntity.label.pixelOffset = new Cartesian2(20, 0) as unknown as typeof labelEntity.label.pixelOffset;
      }
    } else if (name === "Orbit" && this.components[name] instanceof Primitive) {
      // Update the model matrix periodically to keep the orbit in the inertial frame
      if (!this.orbitPrimitiveUpdater) {
        this.orbitPrimitiveUpdater = CesiumCallbackHelper.createPeriodicTimeCallback(this.viewer, 0.5, (time) => {
          if (!this.components.Orbit) {
            // Remove callback if orbit is disabled
            this.orbitPrimitiveUpdater?.();
            return;
          }
          const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time);
          if (defined(icrfToFixed)) {
            (this.components.Orbit as Primitive).modelMatrix = Matrix4.fromRotationTranslation(icrfToFixed);
          }
        });
      }
    } else if (name === "Orbit" && this.components[name] instanceof GeometryInstance) {
      // Update the model matrix of the primitive containing all orbit geometries periodically to keep the orbit in the inertial frame
      const ctor = this.constructor as typeof SatelliteComponentCollection;
      if (!ctor.geometryPrimitiveUpdater) {
        if (!this.components.Orbit) {
          // Note: original code referenced an undefined geometryPrimitiveUpdater() here; preserve as no-op
          return;
        }
        ctor.geometryPrimitiveUpdater = CesiumCallbackHelper.createPeriodicTimeCallback(this.viewer, 0.5, (time) => {
          const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time);
          if (defined(icrfToFixed) && ctor.primitive) {
            ctor.primitive.modelMatrix = Matrix4.fromRotationTranslation(icrfToFixed);
          }
        });
      }
    }
  }

  override disableComponent(name: SatelliteComponentName): void {
    if (name === "3D model") {
      // Restore old label offset
      const labelEntity = this.components.Label as Entity | undefined;
      if (labelEntity?.label) {
        labelEntity.label.pixelOffset = new Cartesian2(10, 0) as unknown as typeof labelEntity.label.pixelOffset;
      }
    }
    super.disableComponent(name);

    if (this.componentNames.length === 0) {
      // Remove event listeners when no components are enabled
      this.deinit();
    }
  }

  init(): void {
    this.createDescription();

    this.eventListeners.sampledPosition = this.props.createSampledPosition(this.viewer, () => {
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
        this.props.updatePasses(this.viewer.clock.currentTime);
        CesiumTimelineHelper.updateHighlightRanges(this.viewer, this.props.passes);
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
    });
  }

  deinit(): void {
    // Remove event listeners
    this.eventListeners.sampledPosition?.();
    this.eventListeners.selectedEntity?.();
    this.eventListeners.trackedEntity?.();
  }

  updatedSampledPositionForComponents(update = false): void {
    if (!this.props.sampledPosition) return;
    const { fixed, inertial } = this.props.sampledPosition;

    Object.entries(this.components).forEach(([type, component]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = component as any;
      if (type === "Orbit") {
        c.position = inertial;
        if (update && (component instanceof Primitive || component instanceof GeometryInstance)) {
          // Primitives need to be recreated to update the geometry
          this.disableComponent("Orbit");
          this.enableComponent("Orbit");
        }
      } else if (type === "Sensor cone") {
        c.position = fixed;
        c.orientation = new CallbackProperty((time?: JulianDate) => {
          const position = this.props.position(time as JulianDate);
          const hpr = new HeadingPitchRoll(0, CesiumMath.toRadians(180), 0);
          return Transforms.headingPitchRollQuaternion(position as Cartesian3, hpr);
        }, false);
      } else {
        c.position = fixed;
        c.orientation = new VelocityOrientationProperty(fixed);
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
    switch (name) {
      case "Point":
        this.createPoint();
        break;
      case "Label":
        this.createLabel();
        break;
      case "Orbit":
        this.createOrbit();
        break;
      case "Orbit track":
        this.createOrbitTrack();
        break;
      case "Ground track":
        this.createGroundTrack();
        break;
      case "Sensor cone":
        this.createCone();
        break;
      case "3D model":
        this.createModel();
        break;
      case "Ground station link":
        this.createGroundStationLink();
        break;
      default:
        console.error("Unknown component");
    }
  }

  createDescription(): void {
    this.description = DescriptionHelper.cachedCallbackProperty((time: JulianDate) => {
      const cartographic = this.props.orbit.positionGeodetic(JulianDate.toDate(time), true);
      const content = DescriptionHelper.renderSatelliteDescription(time, cartographic, this.props);
      return content;
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCesiumSatelliteEntity(entityName: string, entityKey: string, entityValue: any): void {
    this.createCesiumEntity(entityName, entityKey, entityValue, this.props.name, this.description, this.props.sampledPosition?.fixed, true);
  }

  createPoint(): void {
    const point = new PointGraphics({
      pixelSize: 6,
      color: Color.WHITE,
      outlineColor: Color.DIMGREY,
      outlineWidth: 1,
    });
    this.createCesiumSatelliteEntity("Point", "point", point);
  }

  createBox(): void {
    const size = 1000;
    const box = new BoxGraphics({
      dimensions: new Cartesian3(size, size, size),
      material: Color.WHITE,
    });
    this.createCesiumSatelliteEntity("Box", "box", box);
  }

  createModel(): void {
    const model = new ModelGraphics({
      uri: `./data/models/${this.props.name.split(" ").join("-")}.glb`,
      minimumPixelSize: 50,
      maximumScale: 10000,
    });
    this.createCesiumSatelliteEntity("3D model", "model", model);
  }

  createLabel(): void {
    const label = new LabelGraphics({
      text: this.props.name,
      font: "15px Arial",
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
    if (this.usePathGraphicForOrbit) {
      this.createOrbitPath();
    } else {
      this.createOrbitPolylineGeometry();
    }
  }

  isCorrectOrbitComponent(): boolean {
    return this.usePathGraphicForOrbit ? this.components.Orbit instanceof Entity : this.components.Orbit instanceof Primitive;
  }

  get usePathGraphicForOrbit(): boolean {
    const sceneModeSupportsPrimitive = this.viewer.scene.mode === SceneMode.SCENE3D;
    if (this.isTracked || !sceneModeSupportsPrimitive) {
      // Use a path graphic to visualize the currently tracked satellite's orbit or when the scene mode doesn't support primitive modelmatrix updates
      return true;
    }
    // For all other satellites use a polyline geometry to visualize the orbit for significantly improved performance.
    // A polyline geometry is used instead of a polyline graphic as entities don't support adjusting the model matrix
    // in order to display the orbit in the inertial frame.
    return false;
  }

  createOrbitPath(): void {
    const path = new PathGraphics({
      leadTime: (this.props.orbit.orbitalPeriod * 60) / 2 + 5,
      trailTime: (this.props.orbit.orbitalPeriod * 60) / 2 + 5,
      material: Color.WHITE.withAlpha(0.15),
      resolution: 600,
      width: 2,
    });
    this.createCesiumEntity("Orbit", "path", path, this.props.name, this.description, this.props.sampledPosition?.inertial, true);
  }

  createOrbitPolylinePrimitive(): void {
    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: new PolylineGeometry({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          positions: this.props.getSampledPositionsForNextOrbit(this.viewer.clock.currentTime) as any,
          width: 2,
          arcType: ArcType.NONE,
          vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(new Color(1.0, 1.0, 1.0, 0.15)),
        },
        id: this.props.name,
      }),
      appearance: new PolylineColorAppearance(),
      asynchronous: false,
    });
    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(this.viewer.clock.currentTime);
    if (defined(icrfToFixed)) {
      primitive.modelMatrix = Matrix4.fromRotationTranslation(icrfToFixed);
    }
    this.components.Orbit = primitive;
  }

  createOrbitPolylineGeometry(): void {
    // Currently unused
    const geometryInstance = new GeometryInstance({
      geometry: new PolylineGeometry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        positions: this.props.getSampledPositionsForNextOrbit(this.viewer.clock.currentTime) as any,
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

  createOrbitTrack(leadTime: number = this.props.orbit.orbitalPeriod * 60, trailTime = 0): void {
    const path = new PathGraphics({
      leadTime,
      trailTime,
      material: Color.GOLD.withAlpha(0.15),
      resolution: 600,
      width: 2,
    });
    this.createCesiumSatelliteEntity("Orbit track", "path", path);
  }

  createGroundTrack(): void {
    if (this.props.orbit.orbitalPeriod > 60 * 2) {
      // Ground track unavailable for non-LEO satellites
      return;
    }
    const corridor = new CorridorGraphics({
      cornerType: CornerType.MITERED,
      height: 1000,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      material: Color.DARKRED.withAlpha(0.25),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      positions: new CallbackProperty((time?: JulianDate) => this.props.groundTrack(time as JulianDate) as any, false),
      width: this.props.swath * 1000,
    });
    this.createCesiumSatelliteEntity("Ground track", "corridor", corridor);
  }

  createCone(fov = 10): void {
    if (this.props.orbit.orbitalPeriod > 60 * 2) {
      // Cone graphic unavailable for non-LEO satellites
      return;
    }
    const entity = new Entity();
    entity.addProperty("conicSensor");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entity as any).conicSensor = new CesiumSensorVolumes.ConicSensorGraphics({
      radius: 1000000,
      innerHalfAngle: CesiumMath.toRadians(0),
      outerHalfAngle: CesiumMath.toRadians(fov),
      lateralSurfaceMaterial: Color.GOLD.withAlpha(0.15),
      intersectionColor: Color.GOLD.withAlpha(0.3),
      intersectionWidth: 1,
    });
    this.components["Sensor cone"] = entity;
  }

  createGroundStationLink(): void {
    if (!this.props.groundStationAvailable) {
      return;
    }
    const polyline = new PolylineGraphics({
      material: new PolylineGlowMaterialProperty({
        glowPower: 0.5,
        color: Color.FORESTGREEN,
      }),
      positions: new CallbackProperty((time?: JulianDate) => {
        const satPosition = this.props.position(time as JulianDate);
        const groundPosition = this.activeGroundStationCartesian(time as JulianDate);
        return [satPosition, groundPosition];
      }, false),
      show: new CallbackProperty((time?: JulianDate) => this.props.passIntervals.contains(time as JulianDate), false),
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
    const groundStations = this.props.groundStations;
    if (groundStations.length === 0) {
      return undefined;
    }
    const timeMs = JulianDate.toDate(time).getTime();
    const activePass = this.props.passes.find((pass) => timeMs >= pass.start && timeMs <= pass.end);
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

    this.props.groundStations = groundStations;
    this.props.clearPasses();
    if (this.isSelected || this.isTracked) {
      this.props.updatePasses(this.viewer.clock.currentTime);
      if (this.isSelected) {
        CesiumTimelineHelper.updateHighlightRanges(this.viewer, this.props.passes);
      }
    }
    if (this.created) {
      this.createGroundStationLink();
    }
  }
}

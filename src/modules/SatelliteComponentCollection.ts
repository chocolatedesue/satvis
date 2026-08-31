import {
  ArcType,
  BoundingSphere,
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

import { clearPassHighlights, setPassHighlights } from "../composables/usePassHighlights";
import { labelOffsetFor, POINT_PIXEL_SIZE, SATELLITE_COMPONENTS } from "../config/components";
import { ILLUMINATION_COLOR, type IlluminationState, type PointPaint } from "../config/illumination";
import { ORBIT_CLASS_COLOR, type OrbitClass } from "../config/orbitClass";
import type { GroundStation } from "./PassPredictor";
import type { CatalogEntry } from "./SatelliteCatalog";
import { coneDescription, coneOrientation, groundTrackDescription, modelUri, orbitPathTimes, orbitTrackTimes, orbitUsesPathGraphic } from "./satelliteGraphics";
import { SatelliteProperties } from "./SatelliteProperties";
import { drawablePositions } from "./util/drawablePositions";
import { illuminationRing, sunGeometry } from "./util/illumination";
import type { PassPredictorSource } from "./util/passSource";
import type { PolylineBatch } from "./util/PolylineBatch";
import type { TrajectorySampler } from "./util/sampleSource";
import { planeSlotOf } from "./util/walkerDelta";

type SatelliteComponentName = string;

/** The shared polyline batches a satellite draws its orbit lines into. */
export interface SatelliteBatches {
  /** Inertial: the Orbit component's closed ellipse. */
  orbits: PolylineBatch;
  /** Fixed: the Orbit track component's Earth-relative path. */
  tracks: PolylineBatch;
  /**
   * Inertial: the Illumination arc component's per-vertex-coloured ellipse.
   *
   * A third batch rather than a second colour in the first one, and not for the
   * frame this time: the arc carries its colour in the *geometry* (one Color per
   * vertex) while a plain orbit carries it as a per-instance attribute. Cesium
   * builds one vertex-attribute layout per Primitive, so instances of the two
   * kinds cannot share one.
   */
  illuminationArcs: PolylineBatch;
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

/** The illumination palette, converted once for the same reason POINT_COLOR is. */
const ILLUMINATION_POINT_COLOR = Object.fromEntries(Object.entries(ILLUMINATION_COLOR).map(([state, hex]) => [state, Color.fromCssColorString(hex)])) as Record<
  IlluminationState,
  Color
>;

/**
 * The same palette for the arc, and at full opacity.
 *
 * The plain orbit is drawn at 15% alpha because it is context — one of ten
 * thousand ellipses nobody is reading individually. The arc is the thing being
 * read, and at 15% none of these five hues is nameable.
 */
const ILLUMINATION_ARC_COLOR = Object.fromEntries(Object.entries(ILLUMINATION_COLOR).map(([state, hex]) => [state, Color.fromCssColorString(hex)])) as Record<
  IlluminationState,
  Color
>;

/**
 * What an illumination-coloured point falls back to when SGP4 declines to say
 * where the satellite is. Its orbit class would be a claim about the sun that
 * nothing supports, so it reads as the neutral instead.
 */
const ILLUMINATION_UNKNOWN_COLOR = Color.fromCssColorString(ORBIT_CLASS_COLOR.LEO);

/**
 * `BoundingSphereState.PENDING`. Written out rather than imported: the enum is
 * exported from the engine's JavaScript but not from its type declarations. See
 * groundTrackSettled.
 */
const BOUNDING_SPHERE_PENDING = 1;

/**
 * How each component is made. Keyed against the config list rather than written
 * out as a switch, so adding a component there without a creator here is a
 * compile error instead of a "Unknown component" at runtime.
 */
const CREATORS: Record<(typeof SATELLITE_COMPONENTS)[number] | typeof GROUND_STATION_LINK, (sat: SatelliteComponentCollection) => void> = {
  Point: (sat) => sat.createPoint(),
  Label: (sat) => sat.createLabel(),
  Orbit: (sat) => sat.createOrbit(),
  "Illumination arc": (sat) => sat.createIlluminationArc(),
  "Orbit track": (sat) => sat.createOrbitTrack(),
  "Ground track": (sat) => sat.createGroundTrack(),
  "Sensor cone": (sat) => sat.createCone(),
  "3D model": (sat) => sat.createModel(),
  [GROUND_STATION_LINK]: (sat) => sat.createGroundStationLink(),
};

/**
 * Below this a polyline is not a polyline. `PolylineGeometry`'s constructor throws
 * rather than declining, and a throw raised while geometry is rebuilt escapes
 * through `clock.tick` into Cesium's render loop, which turns
 * `_useDefaultRenderLoop` off and stops the app for the rest of the session.
 */
const MIN_POLYLINE_POSITIONS = 2;

/**
 * An Entity when the component is drawn on its own, a GeometryInstance when it is
 * merged into the shared orbit batch. Never a Primitive: the one creator that made
 * one was dead code, and the branch checking for it could never be true.
 */
type Component = Entity | GeometryInstance;

/** One satellite's Cesium objects, created on demand and dropped on disable. */
export class SatelliteComponentCollection {
  /** Written into by `getBoundingSphere` and never read. See groundTrackSettled. */
  static readonly #sphereScratch = new BoundingSphere();

  /** So a broken assumption is reported once rather than on every tick. */
  static #reportedMissingBoundingSphere = false;

  static #reportMissingBoundingSphere(): void {
    if (SatelliteComponentCollection.#reportedMissingBoundingSphere) {
      return;
    }
    SatelliteComponentCollection.#reportedMissingBoundingSphere = true;
    console.error("Cesium DataSourceDisplay has no getBoundingSphere; pacing ground tracks on a fixed schedule instead. Cesium internals have moved — see groundTrackSettled.");
  }

  readonly viewer: Viewer;

  readonly props: SatelliteProperties;

  /**
   * The batches every untracked orbit and orbit track are drawn into. Passed in
   * rather than reached for: they are shared by every satellite, and one owner
   * beats a static.
   */
  readonly #orbits: PolylineBatch;

  readonly #tracks: PolylineBatch;

  readonly #illuminationArcs: PolylineBatch;

  /**
   * How points are painted right now. Shared by reference with every other
   * satellite and owned by the SatelliteManager, so this reads the live value
   * rather than a copy taken at construction.
   */
  readonly #paint: PointPaint;

  #components: Record<string, Component> = {};

  /** What a click or a track acts on — the first Entity to be created. */
  defaultEntity: Entity | undefined;

  eventListeners: Record<string, () => void> = {};

  constructor(viewer: Viewer, entry: CatalogEntry, batches: SatelliteBatches, sampler: TrajectorySampler, passes: PassPredictorSource, paint: PointPaint) {
    this.viewer = viewer;
    this.props = new SatelliteProperties(entry, sampler, passes);
    this.#orbits = batches.orbits;
    this.#tracks = batches.tracks;
    this.#illuminationArcs = batches.illuminationArcs;
    this.#paint = paint;
  }

  /**
   * Put this satellite's passes on the clock deck's ruler, once they exist.
   *
   * Prediction is off-thread, so the list a read returns may be the previous one
   * or nothing at all. Publishing what is known now and again when the answer
   * lands is the whole adaptation: the first call paints a stale or empty band and
   * costs nothing, the second paints the real one.
   */
  #highlightPasses(): void {
    const predictor = this.props.passPredictor;
    const time = this.viewer.clock.currentTime;
    if (this.isSelected) {
      setPassHighlights(predictor.passes(time));
    } else {
      // Not selected: nothing to paint, but the tracked satellite still wants the
      // window computed for its ground-station link.
      predictor.passes(time);
    }
  }

  #batchFor(name: SatelliteComponentName): PolylineBatch {
    if (name === "Orbit track") {
      return this.#tracks;
    }
    return name === "Illumination arc" ? this.#illuminationArcs : this.#orbits;
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
      if (componentName === "3D model") {
        // Constant pitch rotation for the 3D model (sat-model-rotation POC 5862a96):
        // a fixed -30 deg/s, enough to read the ADCS rotation in the migration demo.
        entity.orientation = new CallbackProperty((time) => {
          if (!time) {
            return undefined;
          }
          const positionNow = position.getValue(time);
          if (!positionNow) {
            return undefined;
          }
          const hpr = new HeadingPitchRoll(0, -CesiumMath.toRadians(30) * time.secondsOfDay, 0);
          return Transforms.headingPitchRollQuaternion(positionNow, hpr);
        }, false);
      } else {
        entity.orientation = new VelocityOrientationProperty(position);
      }
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
      // So the model does not cover the label.
      this.#setLabelOffset(20);
    }
  }

  disableComponent(name: SatelliteComponentName): void {
    if (name === "3D model") {
      // Back to whatever the point's own size asks for, not a hardcoded 10.
      this.#setLabelOffset(labelOffsetFor(this.#paint.size));
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

    // Pass prediction answers late now, so the things derived from a pass list
    // have to be told rather than to ask. The ground-station link reads
    // passIntervals through a CallbackProperty and needs nothing; the timeline
    // bands are painted once and do.
    this.eventListeners.passesChanged = this.props.passPredictor.onChanged(() => {
      if (this.isSelected) {
        setPassHighlights(this.props.passPredictor.passes(this.viewer.clock.currentTime));
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.eventListeners.selectedEntity = this.viewer.selectedEntityChanged.addEventListener((entity: any) => {
      if (!entity || entity?.name === "Ground station") {
        clearPassHighlights();
        return;
      }
      if (this.isSelected) {
        this.#highlightPasses();
      }
    });

    this.eventListeners.trackedEntity = this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.isTracked) {
        this.artificiallyTrack();
      }
      if ("Orbit" in this.components && !this.isCorrectOrbitComponent()) {
        // Rebuilt rather than adjusted: a geometry cannot change visualisation
        // type in place.
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
    // Every one of them, by iterating rather than by naming: the pass listener was
    // added to `init` and missed here, and an enable/disable cycle then left one
    // more subscriber on the predictor's list every time round.
    Object.values(this.eventListeners).forEach((remove) => remove?.());
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
    const { entityPosition } = this.props.trajectory;
    // Neither the inertial frame nor the sampled property: both are absent unless
    // a component asked for them, and requiring either here would have stopped
    // every other component updating in exactly the scenes the laziness is for.
    if (!entityPosition) return;

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
      } else if (type === "Illumination arc") {
        if (update) {
          // Cut from the inertial samples, so a window that has just slid leaves the
          // arc describing positions the satellite has already left.
          this.refreshIlluminationArc(this.viewer.clock.currentTime);
        }
      } else if (type === "Orbit track") {
        if (component instanceof Entity) {
          // The sampled property, not the grid — this one is a path, and an Orbit
          // track Entity exists only because createOrbitTrackPath asked for it.
          this.props.trajectory.requireSampled();
          component.position = this.props.trajectory.fixed;
        } else if (update) {
          // The window it was cut from has just moved, so the samples behind the
          // batched geometry are the old ones. Re-cut rather than rebuild the
          // membership: replace() leaves the batch the same size.
          this.refreshOrbitTrack(this.viewer.clock.currentTime);
        }
      } else if (component instanceof Entity) {
        if (type === "Sensor cone") {
          component.position = entityPosition;
          component.orientation = new CallbackProperty((time?: JulianDate) => coneOrientation(this.props.trajectory.position(time as JulianDate)), false);
        } else {
          component.position = entityPosition;
          component.orientation = new VelocityOrientationProperty(entityPosition);
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

  /**
   * An entity at the satellite, positioned by the grid property.
   *
   * Everything that only asks where the satellite is right now belongs here. A
   * path graphic does not — it sub-samples the property it is given, and Cesium
   * only knows how to do that densely for its own `SampledPositionProperty` — so
   * `createOrbitTrackPath` and `createOrbitPath` build their entities directly.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCesiumSatelliteEntity(entityName: string, entityKey: string, entityValue: any): void {
    this.createCesiumEntity(entityName, entityKey, entityValue, this.props.name, this.props.trajectory.entityPosition, true);
  }

  // Coloured by orbit regime, matching the badge the satellite browser shows on
  // the same satellite's row — so the menu reads as the legend for the globe. In
  // illumination mode it is coloured by what the sun is doing to it instead; see
  // `#illuminationColor`.
  //
  // Small by default on purpose: a whole constellation at 6 px merges into a sheet
  // that hides the globe under it. 5 px still leaves the globe legible under a full
  // Starlink activation, and the outline is what keeps a point visible against
  // bright imagery rather than its size. A scene of two orbits is the other case
  // entirely, which is what the size setting is for (config/components.ts).
  createPoint(): void {
    const point = new PointGraphics({
      pixelSize: POINT_PIXEL_SIZE[this.#paint.size],
      color: this.#paint.mode === "illumination" ? this.#illuminationColor() : POINT_COLOR[this.props.orbitClass],
      outlineColor: Color.DIMGREY,
      outlineWidth: 1,
    });
    this.createCesiumSatelliteEntity("Point", "point", point);
  }

  /**
   * The point's colour as a function of the clock, for illumination mode.
   *
   * A CallbackProperty, so it is only ever built for satellites that are actually
   * painted this way — a mode change tears the points down and remakes them
   * (SatelliteManager.repaintPoints) rather than leaving every point in the
   * catalog evaluating a callback that returns a constant. The per-satellite
   * memoization behind `props.illumination` is what keeps the per-frame read from
   * being a per-frame SGP4 propagation.
   */
  #illuminationColor(): CallbackProperty {
    return new CallbackProperty((time: JulianDate | undefined) => {
      // Cesium types the time as optional because a Property can be evaluated
      // without one. There is no illumination without an instant, so an absent
      // time is the same answer as an absent position.
      if (!time) {
        return ILLUMINATION_UNKNOWN_COLOR;
      }
      const illumination = this.props.illumination(JulianDate.toDate(time), this.#paint.panelAxis);
      return illumination ? ILLUMINATION_POINT_COLOR[illumination.state] : ILLUMINATION_UNKNOWN_COLOR;
    }, false);
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
      // Generated constellation satellites are labelled by the two numbers that place
      // them — plane and slot — rather than by their full name. The rest of that name
      // is the pattern they came from, which is identical for every satellite in the
      // scene, so repeating it twenty times says nothing and costs the width that
      // would have shown which satellite this is. A real catalogued satellite has no
      // plane or slot and keeps its name.
      text: planeSlotOf(this.props.name) ?? this.props.name,
      font: "13px Arial",
      fillColor: POINT_COLOR.LEO,
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineColor: Color.DIMGREY,
      outlineWidth: 2,
      horizontalOrigin: HorizontalOrigin.LEFT,
      // Clear of the marker at whatever size the marker is: at 14 px a fixed 10 px
      // offset starts the text inside the point it names.
      pixelOffset: new Cartesian2(labelOffsetFor(this.#paint.size), 0),
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
    const positions = this.props.trajectory.positionsForNextOrbit(this.viewer.clock.currentTime);
    if (positions.length < MIN_POLYLINE_POSITIONS) {
      return;
    }
    const geometryInstance = new GeometryInstance({
      geometry: new PolylineGeometry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        positions: positions as any,
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

  /**
   * The orbit line itself, cut into the sun's own colours.
   *
   * The second way of showing what the point colouring shows, and the one that
   * needs no clock to read: where the plain Orbit is one translucent ellipse, this
   * draws the same ellipse with each vertex carrying its own illumination state, so
   * the eclipsed arc, the penumbra slivers either side of it and the arc where the
   * panel has turned away are all visible at once, in place, without waiting for
   * the satellite to fly through them.
   *
   * Independent of `pointColorMode`: this is a component someone switches on, not a
   * mode that repaints what is already there.
   */
  createIlluminationArc(): void {
    // Same declaration the Orbit component makes, and for the same reason: the
    // inertial sample set exists only because something asked for it.
    this.props.trajectory.requireInertial();
    const geometry = this.#illuminationArcGeometry(this.viewer.clock.currentTime);
    if (geometry) {
      this.components["Illumination arc"] = geometry;
    }
  }

  /**
   * One polyline, one colour per vertex.
   *
   * `colorsPerVertex` rather than one instance per state run: a run boundary is a
   * vertex either way, and a single geometry keeps this component the same shape as
   * every other one — one GeometryInstance the existing enable/disable and
   * `replace` paths already handle. It also gives the boundaries a one-segment
   * gradient instead of a hard edge, which is what a penumbra actually looks like.
   */
  #illuminationArcGeometry(time: JulianDate): GeometryInstance | undefined {
    const positions = drawablePositions(this.props.trajectory.positionsForNextOrbit(time) as (Cartesian3 | undefined)[]);
    if (positions.length < MIN_POLYLINE_POSITIONS) {
      return undefined;
    }
    const sun = sunGeometry(JulianDate.toDate(time));
    if (!sun) {
      return undefined;
    }
    // Cesium works in metres and the shadow model in kilometres. The ring comes back
    // longer than it went in: the state boundaries are refined, because the penumbra
    // is shorter than one sample interval and would otherwise not be drawn at all.
    const ring = illuminationRing(
      positions.map((position) => ({ x: position.x / 1000, y: position.y / 1000, z: position.z / 1000 })),
      sun,
      this.#paint.panelAxis,
    );
    return new GeometryInstance({
      geometry: new PolylineGeometry({
        positions: ring.positionsKm.map((position) => new Cartesian3(position.x * 1000, position.y * 1000, position.z * 1000)),
        colors: ring.states.map((state) => (state ? ILLUMINATION_ARC_COLOR[state] : ILLUMINATION_UNKNOWN_COLOR)),
        colorsPerVertex: true,
        // Wider than the plain orbit's 2 px. The arc is read rather than glanced at,
        // and its darkest state is a dark line: at 2 px the eclipsed arc disappears
        // into a lit globe behind it.
        width: 4,
        arcType: ArcType.NONE,
        vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
      }),
      id: this.props.name,
    });
  }

  /**
   * Re-cut the arc so its colours still describe where the sun is.
   *
   * Unlike the inertial orbit it is cut from, this one does go stale: the ellipse
   * is fixed in inertial space and a model matrix keeps it current, but the sun
   * moves through that space — 0.04° an hour, which is nothing across one orbit and
   * a whole eclipse season at ×86400. Re-cut on the same schedule as the
   * Earth-relative tracks, which have the same shape of problem.
   */
  refreshIlluminationArc(time: JulianDate): void {
    const current = this.#components["Illumination arc"];
    if (!(current instanceof GeometryInstance)) {
      return;
    }
    const next = this.#illuminationArcGeometry(time);
    if (next && this.#illuminationArcs.replace(current, next)) {
      this.#components["Illumination arc"] = next;
    }
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
    // The sampled property, so PathVisualizer sub-samples at the stored sample
    // times rather than at `resolution`. Asking is what brings it into being —
    // only the tracked satellite and the non-3D scene modes draw a path.
    this.props.trajectory.requireSampled();
    this.createCesiumEntity("Orbit track", "path", path, this.props.name, this.props.trajectory.fixed, true);
  }

  /** The track as a geometry for the shared batch — how every untracked track is drawn in 3D. */
  createOrbitTrackPolylineGeometry(): void {
    const geometry = this.#orbitTrackGeometry(this.viewer.clock.currentTime);
    if (geometry) {
      this.components["Orbit track"] = geometry;
    }
  }

  #orbitTrackGeometry(time: JulianDate): GeometryInstance | undefined {
    const positions = this.props.trajectory.positionsForTrack(time);
    if (positions.length < MIN_POLYLINE_POSITIONS) {
      return undefined;
    }
    return new GeometryInstance({
      geometry: new PolylineGeometry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        positions: positions as any,
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
    if (next && this.#tracks.replace(current, next)) {
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
      return;
    }
    const positions = this.#groundTrackPositions(this.viewer.clock.currentTime);
    // The same check `refreshGroundTrack` makes, and for the same reason: a
    // corridor Cesium cannot build geometry from takes the render loop down with
    // it.
    if (positions.length < 2) {
      return;
    }
    const corridor = new CorridorGraphics({
      cornerType: CornerType.MITERED,
      height: 1000,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      material: Color.DARKRED.withAlpha(0.25),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      positions: positions as any,
      width: description.widthMeters,
    });
    this.createCesiumSatelliteEntity("Ground track", "corridor", corridor);
  }

  /**
   * The ground track as positions a corridor can be built from.
   *
   * Holes are dropped because the sampled position has no value outside its
   * window and a corridor handed one throws from inside Cesium's geometry worker.
   * Duplicates are dropped because the corridor collapses them itself and then
   * declines to build anything, which costs more — see `drawablePositions`.
   *
   * Duplicates are the case that arrives. Outside the sample window
   * `GridPositionProperty` clamps its stencil to the window's edge by design, so
   * every time beyond it reads back the same edge sample: two instants 300 s apart
   * answer with one point. Not `ExtrapolationType` — that governs the sampled
   * property, which most satellites never build.
   */
  #groundTrackPositions(time: JulianDate): Cartesian3[] {
    return drawablePositions(this.props.trajectory.groundTrack(time));
  }

  /** See createGroundTrack. */
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

  /**
   * Whether the corridor Cesium is drawing has caught up with the positions it
   * was last handed, or undefined when there is nothing to ask — no ground track
   * on this satellite, or no way to ask about one.
   *
   * Worth asking because the rebuild takes a number of frames that varies with
   * the size of the batch, so any fixed schedule is either slower than it needs
   * to be or fast enough to discard an unfinished rebuild. See SatelliteManager's
   * GROUND_TRACK_REFRESH_FRAMES for what the second of those does.
   *
   * `getBoundingSphere` is what Cesium itself calls once a frame to decide
   * whether the tracked entity can be followed yet, and it reports PENDING for
   * as long as the batch primitive behind the entity is unfinished — measured as
   * landing one frame before the new corridor is drawn. Cesium marks it private
   * and leaves it out of its type declarations, hence the cast and the check: if
   * it goes away the caller falls back to a fixed schedule rather than silently
   * never waiting again.
   */
  groundTrackSettled(): boolean | undefined {
    const entity = this.#components["Ground track"];
    if (!(entity instanceof Entity) || !entity.corridor) {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const display = this.viewer.dataSourceDisplay as any;
    if (typeof display?.getBoundingSphere !== "function") {
      SatelliteComponentCollection.#reportMissingBoundingSphere();
      return undefined;
    }
    return display.getBoundingSphere(entity, false, SatelliteComponentCollection.#sphereScratch) !== BOUNDING_SPHERE_PENDING;
  }

  createCone(fov = this.props.coneFovDeg): void {
    const description = coneDescription(this.props.orbitClass, fov);
    if (!description) {
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

    // The setter clears the predictor's window; ask for the new one now so
    // pass-dependent visuals update without waiting for a read. The answer is
    // off-thread, so it arrives via the listener rather than here.
    this.props.passPredictor.groundStations = groundStations;
    if (this.isSelected || this.isTracked) {
      this.#highlightPasses();
    }
    if (this.created) {
      this.createGroundStationLink();
    }
  }
}

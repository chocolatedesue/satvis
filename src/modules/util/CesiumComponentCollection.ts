import {
  Cartesian3,
  type Clock,
  Entity,
  EntityView,
  GeometryInstance,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  PolylineColorAppearance,
  Primitive,
  SceneMode,
  Transforms,
  VelocityOrientationProperty,
  defined,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

type Component = Entity | Primitive | GeometryInstance;

/** CesiumComponentCollection
 *
 * A wrapper class for Cesium entities and primitives that all belong to a common object being represented.
 * The individual entities or primitives are created on demand by the inheriting child class and are added
 * to a common entity collection or primitive collection shared between all ComponentCollections.
 */
export class CesiumComponentCollection {
  #components: Record<string, Component> = {};

  static geometries: GeometryInstance[] = [];

  static primitive: Primitive | undefined = undefined;

  static primitivePendingUpdate = false;

  static primitivePendingCreation = false;

  viewer: Viewer;

  lazy: boolean;

  defaultEntity: Entity | undefined;

  constructor(viewer: Viewer, lazy = true) {
    this.viewer = viewer;
    // Create entities only when needed and delete them on disable
    this.lazy = lazy;
  }

  get components(): Record<string, Component> {
    return this.#components;
  }

  get componentNames(): string[] {
    return Object.keys(this.components);
  }

  get created(): boolean {
    return this.componentNames.length > 0;
  }

  show(componentNames: string[] = this.componentNames): void {
    componentNames.forEach((componentName) => {
      this.enableComponent(componentName);
    });
  }

  hide(componentNames: string[] = this.componentNames): void {
    componentNames.forEach((componentName) => {
      this.disableComponent(componentName);
    });
  }

  enableComponent(name: string): void {
    if (!(name in this.components)) {
      return;
    }
    const component = this.components[name];
    if (component instanceof Entity && !this.viewer.entities.contains(component)) {
      this.viewer.entities.add(component);
    } else if (component instanceof Primitive && !this.viewer.scene.primitives.contains(component)) {
      this.viewer.scene.primitives.add(component);
    } else if (component instanceof GeometryInstance) {
      (this.constructor as typeof CesiumComponentCollection).geometries.push(component);
      this.recreateGeometryInstancePrimitive();
    }
    if (!this.defaultEntity && component instanceof Entity) {
      this.defaultEntity = component;
    }
  }

  disableComponent(name: string): void {
    if (!(name in this.components)) {
      return;
    }
    const component = this.components[name];
    const ctor = this.constructor as typeof CesiumComponentCollection;
    if (component instanceof Entity) {
      this.viewer.entities.remove(component);
    } else if (component instanceof Primitive) {
      this.viewer.scene.primitives.remove(component);
    } else if (component instanceof GeometryInstance) {
      ctor.geometries = ctor.geometries.filter((geometry) => geometry !== component);
      this.recreateGeometryInstancePrimitive();
    }
    if (this.lazy) {
      delete this.components[name];
    }
  }

  recreateGeometryInstancePrimitive(): void {
    const ctor = this.constructor as typeof CesiumComponentCollection;
    if (ctor.primitivePendingUpdate) {
      return;
    }
    ctor.primitivePendingUpdate = true;
    const removeCallback = CesiumCallbackHelper.createPeriodicTickCallback(this.viewer, 30, () => {
      if (ctor.primitivePendingCreation) {
        return;
      }
      ctor.primitivePendingUpdate = false;
      if (ctor.geometries.length === 0) {
        this.viewer.scene.primitives.remove(ctor.primitive);
        ctor.primitive = undefined;
        this.viewer.scene.requestRender();
        return;
      }
      ctor.primitivePendingCreation = true;
      const primitive = new Primitive({
        geometryInstances: ctor.geometries,
        appearance: new PolylineColorAppearance(),
      });
      // Force asyncrounous primitve creation before adding to scene
      let lastState = -1;
      const readyCallback = this.viewer.clock.onTick.addEventListener(() => {
        if (!primitive.ready) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (primitive as any)._state;
          if (state !== lastState) {
            lastState = state;
            // Trigger primitive update to progress through creation states
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (primitive as any).update(this.viewer.scene.frameState);
            return;
          }
          return;
        }
        // Update model matrix right before adding to scene. modelMatrix (inertial frame)
        // is only supported in 3D, so skip it in 2D/Columbus to avoid throwing inside the
        // render loop; the default identity matrix renders fine there.
        if (this.viewer.scene.mode === SceneMode.SCENE3D) {
          const icrfToFixed = Transforms.computeIcrfToFixedMatrix(this.viewer.clock.currentTime);
          if (defined(icrfToFixed)) {
            primitive.modelMatrix = Matrix4.fromRotationTranslation(icrfToFixed);
          }
        }
        if (ctor.primitive) {
          this.viewer.scene.primitives.remove(ctor.primitive);
        }
        this.viewer.scene.primitives.add(primitive);
        ctor.primitive = primitive;
        this.viewer.scene.requestRender();
        ctor.primitivePendingCreation = false;
        readyCallback();
      });
      removeCallback();
    });
  }

  /**
   * Returns an array of all components that are added to the viewer.
   */
  get visibleComponents(): Component[] {
    return Object.values(this.components).filter((component) => {
      if (component instanceof Entity) {
        return this.viewer.entities.contains(component);
      }
      if (component instanceof Primitive) {
        return this.viewer.scene.primitives.contains(component);
      }
      return false;
    });
  }

  get isSelected(): boolean {
    return Object.values(this.components).some((entity) => this.viewer.selectedEntity === entity);
  }

  get isTracked(): boolean {
    return Object.values(this.components).some((entity) => this.viewer.trackedEntity === entity);
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

    this.viewer
      .flyTo(this.defaultEntity, {
        offset: new HeadingPitchRange(0, -CesiumMath.PI_OVER_FOUR, 1580000),
      })
      .then((result: boolean) => {
        if (result) {
          this.viewer.trackedEntity = this.defaultEntity;
          this.viewer.clock.shouldAnimate = clockRunning;
        }
      });
  }

  setSelectedOnTickCallback(onTickCallback: (clock: Clock) => void = () => {}, onUnselectCallback: () => void = () => {}): void {
    const onTickEventRemovalCallback = this.viewer.clock.onTick.addEventListener((clock: Clock) => {
      onTickCallback(clock);
    });
    const onSelectedEntityChangedRemovalCallback = this.viewer.selectedEntityChanged.addEventListener(() => {
      onTickEventRemovalCallback();
      onSelectedEntityChangedRemovalCallback();
      onUnselectCallback();
    });
  }

  setTrackedOnTickCallback(onTickCallback: (clock: Clock) => void = () => {}, onUntrackCallback: () => void = () => {}): void {
    const onTickEventRemovalCallback = this.viewer.clock.onTick.addEventListener((clock: Clock) => {
      onTickCallback(clock);
    });
    const onTrackedEntityChangedRemovalCallback = this.viewer.trackedEntityChanged.addEventListener(() => {
      onTickEventRemovalCallback();
      onTrackedEntityChangedRemovalCallback();
      onUntrackCallback();
    });
  }

  artificiallyTrack(onTickCallback: () => void = () => {}, onUntrackCallback: () => void = () => {}): void {
    const cameraTracker = new EntityView(this.defaultEntity as Entity, this.viewer.scene, this.viewer.scene.globe.ellipsoid);
    this.setTrackedOnTickCallback(
      (clock) => {
        cameraTracker.update(clock.currentTime);
        onTickCallback();
      },
      () => {
        onUntrackCallback();
        // Restore default view angle if no new entity is tracked
        if (typeof this.viewer.trackedEntity === "undefined" && this.defaultEntity) {
          this.viewer.flyTo(this.defaultEntity, {
            offset: new HeadingPitchRange(0, CesiumMath.toRadians(-90.0), 2000000),
          });
        }
      },
    );
  }

  createCesiumEntity(
    componentName: string,
    entityKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entityValue: any,
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    position: any,
    moving: boolean,
  ): void {
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
    this.components[componentName] = entity;
  }
}

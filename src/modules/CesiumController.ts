import {
  Cartesian3,
  Cartographic,
  Color,
  Credit,
  ImageryLayer,
  JulianDate,
  Math as CesiumMath,
  Matrix4,
  PerspectiveFrustum,
  type Scene,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TimeInterval,
  Transforms,
  defined,
} from "@cesium/engine";
import { Viewer } from "@cesium/widgets";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { currentPosition } from "../composables/useGeolocation";
import { usePostHog } from "../composables/usePostHog";
import { useToastProxy } from "../composables/useToastProxy";
import { parseLayer } from "../config/layers";
import { CAMERA_MODES, SCENE_MODES } from "../config/viewModes";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import {
  baseLayerNames,
  type ImageryProviderEntry,
  imageryProviders,
  overlayLayerNames,
  type TerrainProviderEntry,
  terrainProviders,
  terrainProviderNames as visibleTerrainProviderNames,
} from "./CesiumLayerProviders";
import { SatelliteManager } from "./SatelliteManager";
import { SkyInteraction } from "./SkyInteraction";
import { SkyView } from "./SkyView";
import { SurfaceModel } from "./SurfaceModel";
import { CesiumPerformanceStats } from "./util/CesiumPerformanceStats";
import { DeviceDetect } from "./util/DeviceDetect";
import { PushManager } from "./util/PushManager";

dayjs.extend(utc);

declare global {
  interface Window {
    cc?: CesiumController;
  }
}

/**
 * Where the globe opens: Europe's meridian, a little north of the equator.
 *
 * Cesium's own default is `Rectangle.fromDegrees(-95, -20, -70, 90)`, a slice up
 * the Americas, which is why the camera used to start over the Carolinas.
 *
 * North of the equator rather than on it so that Europe is clear of the limb,
 * and only a little, because orbits culminate toward the equator and a view that
 * climbs much further north starts cutting off the southern hemisphere.
 */
const DEFAULT_VIEW_LON = 15;
const DEFAULT_VIEW_LAT = 25;

/**
 * How much of the screen's narrower axis the globe spans on opening. Under one so
 * the whole disc is in frame with room around it, rather than touching two edges.
 */
const DEFAULT_VIEW_FILL = 0.82;

export class CesiumController {
  viewer: Viewer;

  minimalUI: boolean;

  sats!: SatelliteManager;

  skyView!: SkyView;

  skyInteraction!: SkyInteraction;

  surface!: SurfaceModel;

  pm!: PushManager;

  sceneModes: string[] = [];

  cameraModes: string[] = [];

  activeLayers: string[] = [];

  performanceStats: CesiumPerformanceStats | undefined;

  oldBottomContainerStyleLeft: string = "";

  // What the store last asked for, and whether anything is currently overriding
  // it. Held separately so releasing a suppression restores the user's choice
  // rather than a guess at it.
  #cameraMode: string = "Fixed";

  #cameraModeSuppressed = false;

  #removeCameraTrackEci: (() => void) | undefined;

  // The same split for terrain, which a surface model can insist on: what the
  // user picked, what is overriding it, and what is actually in the viewer.
  #terrainProvider: string = "None";

  #terrainOverride: string | undefined;

  #terrainGeneration = 0;

  // The last surface model the store asked for, so the selection is reported once
  // rather than every time the view mode makes it re-apply.
  #selectedSurfaceModel: string | undefined;

  constructor() {
    this.preloadReferenceFrameData();
    this.minimalUI = DeviceDetect.inIframe() || DeviceDetect.isIos();

    this.viewer = new Viewer("cesiumContainer", {
      animation: !this.minimalUI,
      // No base layer here: the store's layer stack is the only default, and it
      // arrives through sceneSync's immediate watcher a tick later. Naming one
      // here as well meant two defaults that could drift, and it created the
      // layer without the availability probe that watcher applies.
      baseLayer: false,
      baseLayerPicker: false,
      fullscreenButton: !this.minimalUI,
      fullscreenElement: document.body,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: !this.minimalUI,
      vrButton: !this.minimalUI,
      contextOptions: {
        webgl: {
          alpha: true,
        },
      },
    });

    // Cesium default settings
    this.viewer.clock.shouldAnimate = true;
    this.viewer.scene.globe.enableLighting = true;
    this.viewer.scene.highDynamicRange = true;
    this.viewer.scene.maximumRenderTimeChange = 1 / 30;
    this.viewer.scene.requestRenderMode = true;
    this.setDefaultView();

    // Export CesiumController for debugger
    window.cc = this;

    // CesiumController config
    this.sceneModes = [...SCENE_MODES];
    this.cameraModes = [...CAMERA_MODES];

    this.createInputHandler();
    this.addErrorHandler();

    // Create Satellite Manager
    this.sats = new SatelliteManager(this.viewer);

    this.skyView = new SkyView(this.viewer.scene);
    this.skyInteraction = new SkyInteraction({
      scene: this.viewer.scene,
      skyView: this.skyView,
      sats: this.sats,
      // Selecting by entity identity is all the info panel needs: it resolves
      // the selection itself off `viewer.selectedEntity`.
      onSelect: (target) => {
        this.viewer.selectedEntity = target.sat.defaultEntity;
      },
    });

    this.surface = new SurfaceModel({
      scene: this.viewer.scene,
      setTerrainOverride: (name) => (name === undefined ? this.releaseTerrain() : this.suppressTerrain(name)),
      onFailure: (name, error) => {
        // The selection goes back to None so the radio, the url and the scene
        // cannot disagree — the same correction the imagery fallback makes — and
        // it is said out loud, because the commonest cause is a token this
        // origin is not allowed to use and nothing else would explain that.
        useCesiumStore().surfaceModel = "None";
        useToastProxy().add({
          title: `${name} unavailable`,
          description: `${error instanceof Error ? error.message : "The tileset could not be loaded"}. Cesium ion needs a token valid for this origin.`,
          color: "warning",
        });
      },
    });

    this.pm = new PushManager();

    // Add privacy policy to credits when not running in iframe
    if (!DeviceDetect.inIframe()) {
      this.viewer.creditDisplay.addStaticCredit(new Credit(`<a href="/privacy.html" target="_blank"><u>Privacy</u></a>`, true));
    }
    this.viewer.creditDisplay.addStaticCredit(new Credit(`Satellite TLE data provided by <a href="https://celestrak.org/NORAD/elements/" target="_blank"><u>Celestrak</u></a>`));

    // Fix Cesium logo in minimal ui mode
    if (this.minimalUI) {
      setTimeout(() => {
        this.fixLogo();
      }, 2500);
    }

    this.activeLayers = [];
  }

  /**
   * Open on the default view, far enough out that the whole globe is in frame.
   *
   * `Camera.DEFAULT_VIEW_RECTANGLE` — what Cesium places the camera by while
   * constructing the viewer, and what put it over the Americas — cannot express
   * this. It frames a *rectangle* in the current frustum, and Cesium's `fov` is
   * the horizontal angle on a landscape viewport and the vertical one otherwise,
   * so a single rectangle means very different distances on different shapes of
   * screen: the 25°-by-110° default lands at 12,700 km on a phone and 23,200 km on
   * a desktop window. On the phone that is not far enough. The globe spans 39° of
   * the 30° the narrow axis has to give and is clipped left and right — Cesium's
   * own default does this too, so the app has always been cutting the globe off
   * there.
   *
   * Framing the globe instead of a rectangle is one line of trigonometry and is
   * the same picture at every aspect ratio. Called after the viewer exists, which
   * is when there is a canvas to measure; Cesium has placed the camera once by
   * then, but no frame has been drawn, so there is nothing to see move.
   */
  setDefaultView(): void {
    const { camera, canvas, globe } = this.viewer.scene;
    if (!(camera.frustum instanceof PerspectiveFrustum) || camera.frustum.fov === undefined) {
      return;
    }
    const aspectRatio = canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1;
    // Whichever angle Cesium is *not* reporting is the narrow one, by the rule
    // above — so the derived angle is always the one the globe has to fit inside.
    const { fov } = camera.frustum;
    const narrow = aspectRatio > 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspectRatio) : 2 * Math.atan(Math.tan(fov / 2) * aspectRatio);
    // The equatorial radius, because that is the widest the disc can be.
    const radius = globe.ellipsoid.maximumRadius;
    const height = radius / Math.sin((narrow / 2) * DEFAULT_VIEW_FILL) - radius;
    camera.setView({ destination: Cartesian3.fromDegrees(DEFAULT_VIEW_LON, DEFAULT_VIEW_LAT, height) });
  }

  preloadReferenceFrameData(): void {
    // Preload reference frame data for a timeframe of 180 days
    const timeInterval = new TimeInterval({
      start: JulianDate.addDays(JulianDate.now(), -60, new JulianDate()),
      stop: JulianDate.addDays(JulianDate.now(), 120, new JulianDate()),
    });
    Transforms.preloadIcrfFixed(timeInterval).then(() => {
      console.log("Reference frame data loaded");
    });
  }

  get imageryProviderNames(): string[] {
    return Object.keys(imageryProviders);
  }

  get baseLayers(): string[] {
    return baseLayerNames();
  }

  get overlayLayers(): string[] {
    return overlayLayerNames();
  }

  set imageryLayers(newLayerNames: string[]) {
    this.clearImageryLayers();
    newLayerNames.forEach((layerName) => {
      const selection = parseLayer(layerName);
      if (selection === undefined) {
        return;
      }
      const layer = this.createImageryLayer(selection.provider, selection.alpha);
      if (layer) {
        this.viewer.scene.imageryLayers.add(layer);
      }
    });
    // The stack now arrives asynchronously — the availability probe resolves
    // after `requestRenderMode` is on — and a globe whose imagery changed
    // between frames is not something Cesium's input handling can notice, so
    // without this the new layer is never tiled and the globe stays blank.
    this.viewer.scene.requestRender();
  }

  clearImageryLayers(): void {
    this.viewer.scene.imageryLayers.removeAll();
  }

  createImageryLayer(imageryProviderName: string, alpha?: number): ImageryLayer | false {
    if (!this.imageryProviderNames.includes(imageryProviderName)) {
      console.error("Unknown imagery layer");
      return false;
    }

    const provider = imageryProviders[imageryProviderName] as ImageryProviderEntry;
    const layer = ImageryLayer.fromProviderAsync(Promise.resolve(provider.create()), {});
    layer.alpha = alpha === undefined ? provider.alpha : alpha;
    return layer;
  }

  get terrainProviderNames(): string[] {
    return visibleTerrainProviderNames();
  }

  set terrainProvider(terrainProviderName: string) {
    if (!this.terrainProviderNames.includes(terrainProviderName)) {
      console.error("Unknown terrain provider");
      return;
    }
    this.#terrainProvider = terrainProviderName;
    // Recorded but not applied while a surface model is imposing a terrain: this
    // is the choice that comes back on release, and building it now would only
    // fetch a provider nothing is going to show.
    if (this.#terrainOverride === undefined) {
      void this.#applyTerrain();
    }
  }

  /**
   * Impose a terrain over the user's choice. Suppression rather than a write, the
   * way the camera mode is suppressed: OSM Buildings needs the terrain it was
   * authored against, and the user's own terrain has to come back untouched the
   * moment it is deselected.
   *
   * Validated against every registered provider, not just the selectable ones, so
   * an override may name a terrain a url is not allowed to.
   */
  suppressTerrain(terrainProviderName: string): void {
    if (!(terrainProviderName in terrainProviders)) {
      console.error("Unknown terrain provider override");
      return;
    }
    this.#setTerrainOverride(terrainProviderName);
  }

  /** Honour the user's own terrain again. */
  releaseTerrain(): void {
    this.#setTerrainOverride(undefined);
  }

  #setTerrainOverride(terrainProviderName: string | undefined): void {
    if (terrainProviderName === this.#terrainOverride) {
      return;
    }
    this.#terrainOverride = terrainProviderName;
    void this.#applyTerrain();
  }

  /**
   * Build the terrain that is actually in force and hand it to the viewer.
   *
   * The generation guard is not ceremony: creating a provider is a fetch, and two
   * changes in quick succession — which is exactly what selecting a surface model
   * does, since it overrides the terrain in the same tick — can resolve out of
   * order and leave the loser applied.
   *
   * Deliberately no "already applied" short-circuit. There was one, remembering the
   * name before awaiting the provider, and it turned a provider that never resolved
   * — a terrain host that hangs rather than refusing — into a terrain that could
   * never be selected again: the marker said applied, the viewer showed something
   * else, and every later request for it returned early. The callers already avoid
   * redundant work, so the only thing the marker bought was a way to lie.
   */
  async #applyTerrain(): Promise<void> {
    const name = this.#terrainOverride ?? this.#terrainProvider;
    const generation = ++this.#terrainGeneration;
    try {
      const provider = await (terrainProviders[name] as TerrainProviderEntry).create();
      if (generation !== this.#terrainGeneration) {
        return;
      }
      this.viewer.terrainProvider = provider;
    } catch (error) {
      // Terrain can fail for a reason the network is not responsible for now that
      // one of them is ion-backed. The previous terrain stays, and the next
      // selection is free to try again.
      console.error(`Terrain provider ${name} failed to load`, error);
    }
  }

  /**
   * Put a surface model selection into effect, and tell the sky view what it is
   * now standing on.
   *
   * The two halves live together because the second is a consequence of the
   * first and neither module should have to know about the other: the surface
   * model can measure a height and the sky view needs one, and wiring them is
   * exactly what this class is for.
   */
  async applySurfaceModel(surfaceModel: string, viewMode: string): Promise<void> {
    // On selection, not on load: what the quota is exposed to is people choosing
    // this, and a choice that fails or that lands in a view mode it cannot apply
    // in is exactly the kind of thing worth seeing. The view mode goes along so
    // the two are still distinguishable.
    if (surfaceModel !== this.#selectedSurfaceModel) {
      this.#selectedSurfaceModel = surfaceModel;
      if (surfaceModel !== "None") {
        usePostHog().posthog.capture("surface_model_selected", { surface_model: surfaceModel, view_mode: viewMode });
      }
    }

    const before = this.surface.active;
    await this.surface.apply(surfaceModel, viewMode);
    const after = this.surface.active;
    if (after === before) {
      return;
    }
    // Only on a change: setting a source re-measures, and re-measuring for a
    // model that is already the one being stood on is a needless round trip.
    this.skyView.setGroundHeightSource(after ? (observer) => this.surface.surfaceHeight(observer) : undefined);
  }

  /**
   * Switch the Cesium projection. Only the three view modes that name a Cesium
   * `SceneMode` come here — "Sky" is a camera placement rather than a
   * projection, and is driven from sceneSync because it needs an observer that
   * only the store can supply.
   */
  morphTo(sceneMode: string): void {
    if (sceneMode === "3D") {
      this.viewer.scene.morphTo3D();
      return;
    }

    const morph = (): void => {
      if (sceneMode === "2D") {
        this.viewer.scene.morphTo2D();
        return;
      }
      if (sceneMode === "Columbus") {
        this.viewer.scene.morphToColumbusView();
      }
    };

    // Suppressed rather than disabled: the user still has Orbit switched on and
    // the toolbar has to keep saying so through the morph. Asking the manager
    // whether it actually suppressed anything avoids reading back a value that
    // this call has already changed.
    if (this.sats.suppressComponent("Orbit")) {
      const enableOrbits = (): void => {
        this.sats.releaseComponent("Orbit");
        this.viewer.scene.morphComplete.removeEventListener(enableOrbits);
      };
      this.viewer.scene.morphComplete.addEventListener(enableOrbits);

      // wait until orbit elements are removed
      const checkPending = (): void => {
        if (!this.sats.pendingUpdate) {
          morph();
        } else {
          requestAnimationFrame(checkPending);
        }
      };
      checkPending();
    } else {
      morph();
    }
  }

  jumpTo(location: string): void {
    switch (location) {
      case "Everest": {
        const target = new Cartesian3(300770.50872389384, 5634912.131394585, 2978152.2865545116);
        const offset = new Cartesian3(6344.974098678562, -793.3419798081741, 2499.9508860763162);
        this.viewer.camera.lookAt(target, offset);
        this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        break;
      }
      case "HalfDome": {
        const target = new Cartesian3(-2489625.0836225147, -4393941.44443024, 3882535.9454173897);
        const offset = new Cartesian3(-6857.40902037546, 412.3284835694358, 2147.5545426812023);
        this.viewer.camera.lookAt(target, offset);
        this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        break;
      }
      default:
        console.error("Unknown location");
    }
  }

  set cameraMode(cameraMode: string) {
    if (cameraMode !== "Inertial" && cameraMode !== "Fixed") {
      console.error("Unknown camera mode");
      return;
    }
    this.#cameraMode = cameraMode;
    this.#applyCameraMode();
  }

  /**
   * Stop honouring the camera mode without changing it — the sky view drives
   * the camera itself, and inertial tracking re-parents it on every frame, so
   * the two cannot share it.
   *
   * Suppressed rather than forced back to Fixed, the way a morph suppresses the
   * Orbit component: the user's choice stands and the toolbar keeps saying so,
   * and no history entry is pushed for a change nobody asked for.
   */
  suppressCameraMode(): void {
    this.#cameraModeSuppressed = true;
    this.#applyCameraMode();
  }

  releaseCameraMode(): void {
    this.#cameraModeSuppressed = false;
    this.#applyCameraMode();
  }

  #applyCameraMode(): void {
    const trackEci = this.#cameraMode === "Inertial" && !this.#cameraModeSuppressed;
    // Tracked by its removal callback rather than by re-deriving it: Cesium's
    // Event happily registers the same listener twice, so asking for Inertial
    // while already inertial would otherwise stack a second one.
    if (trackEci && !this.#removeCameraTrackEci) {
      this.#removeCameraTrackEci = this.viewer.scene.postUpdate.addEventListener(this.cameraTrackEci);
    } else if (!trackEci && this.#removeCameraTrackEci) {
      this.#removeCameraTrackEci();
      this.#removeCameraTrackEci = undefined;
    }
  }

  cameraTrackEci(scene: Scene, time: JulianDate): void {
    if (scene.mode !== SceneMode.SCENE3D) {
      return;
    }

    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time);
    if (defined(icrfToFixed)) {
      const { camera } = scene;
      const offset = Cartesian3.clone(camera.position);
      const transform = Matrix4.fromRotationTranslation(icrfToFixed);
      camera.lookAtTransform(transform, offset);
    }
  }

  setTime(
    current: string | number | Date,
    start: string = dayjs.utc(current).subtract(12, "hour").toISOString(),
    stop: string = dayjs.utc(current).add(7, "day").toISOString(),
  ): void {
    this.viewer.clock.startTime = JulianDate.fromIso8601(dayjs.utc(start).toISOString());
    this.viewer.clock.stopTime = JulianDate.fromIso8601(dayjs.utc(stop).toISOString());
    this.viewer.clock.currentTime = JulianDate.fromIso8601(dayjs.utc(current).toISOString());
    if (typeof this.viewer.timeline !== "undefined") {
      this.viewer.timeline.updateFromClock();
      this.viewer.timeline.zoomTo(this.viewer.clock.startTime, this.viewer.clock.stopTime);
    }
  }

  createInputHandler(): void {
    const handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
      const { pickMode } = useCesiumStore();
      if (!pickMode) {
        return;
      }
      this.setGroundStationFromClickEvent(event);
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  setGroundStationFromClickEvent(event: ScreenSpaceEventHandler.PositionedEvent): void {
    const cartesian = this.viewer.camera.pickEllipsoid(event.position);
    if (!defined(cartesian)) {
      return;
    }
    const cartographicPosition = Cartographic.fromCartesian(cartesian);
    this.addGroundStation(CesiumMath.toDegrees(cartographicPosition.latitude), CesiumMath.toDegrees(cartographicPosition.longitude));
    useCesiumStore().pickMode = false;
  }

  /**
   * Through `currentPosition` rather than `navigator.geolocation` directly: this
   * used to pass no error callback at all, so a declined permission left the
   * button doing nothing, silently and forever.
   */
  async setGroundStationFromGeolocation(): Promise<void> {
    const fix = await currentPosition();
    if (!fix) {
      useToastProxy().add({
        title: "Location unavailable",
        description: "No position came back. Check this site's location permission, and note that geolocation needs a secure context.",
        color: "warning",
      });
      return;
    }
    this.addGroundStation(fix.lat, fix.lon, "Geolocation");
  }

  setGroundStationFromLatLon(lat: number, lon: number): void {
    this.addGroundStation(lat, lon);
  }

  // Ground stations are store state; the scene sync turns them into entities.
  // Note the coordinates are not truth-tested here: 0 is a real latitude, and
  // the filter that used to live downstream tested `lat && lon`, so it erased
  // any station on the equator or the Greenwich meridian.
  private addGroundStation(lat: number, lon: number, name = ""): void {
    const satStore = useSatStore();
    satStore.setGroundStations([...satStore.groundStations, { lat, lon, ...(name ? { name } : {}) }]);
  }

  set showUI(enabled: boolean) {
    if (enabled) {
      this.viewer._animation.container.style.visibility = "";
      this.viewer._timeline.container.style.visibility = "";
      this.viewer._fullscreenButton._container.style.visibility = "";
      this.viewer._vrButton._container.style.visibility = "";
      this.viewer._bottomContainer.style.left = this.oldBottomContainerStyleLeft;
      this.viewer._bottomContainer.style.bottom = "30px";
    } else {
      this.viewer._animation.container.style.visibility = "hidden";
      this.viewer._timeline.container.style.visibility = "hidden";
      this.viewer._fullscreenButton._container.style.visibility = "hidden";
      this.viewer._vrButton._container.style.visibility = "hidden";
      this.oldBottomContainerStyleLeft = this.viewer._bottomContainer.style.left;
      this.viewer._bottomContainer.style.left = "5px";
      this.viewer._bottomContainer.style.bottom = "0px";
    }
  }

  get showUI(): boolean {
    return this.viewer._timeline.container.style.visibility !== "hidden";
  }

  fixLogo(): void {
    if (this.minimalUI) {
      this.viewer._bottomContainer.style.left = "5px";
    }
    if (DeviceDetect.isiPhoneWithNotchVisible()) {
      this.viewer._bottomContainer.style.bottom = "20px";
    }
  }

  set qualityPreset(quality: string) {
    switch (quality) {
      case "low":
        // Ignore browser's device pixel ratio and use CSS pixels instead of device pixels for render resolution
        this.viewer.useBrowserRecommendedResolution = true;
        break;
      case "high":
        // Use browser's device pixel ratio for render resolution
        this.viewer.useBrowserRecommendedResolution = false;
        break;
      default:
        console.error("Unknown quality preset");
    }
  }

  set showFps(value: boolean) {
    this.viewer.scene.debugShowFramesPerSecond = value;
  }

  set background(active: boolean) {
    if (!active) {
      this.viewer.scene.backgroundColor = Color.TRANSPARENT;
      this.viewer.scene.moon = undefined;
      this.viewer.scene.skyAtmosphere = undefined;
      this.viewer.scene.skyBox = undefined;
      this.viewer.scene.sun = undefined;
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
      const container = document.getElementById("cesiumContainer");
      if (container) container.style.background = "transparent";
    }
  }

  enablePerformanceStats(logContinuously = false): void {
    this.performanceStats = new CesiumPerformanceStats(this.viewer.scene, logContinuously);
  }

  addErrorHandler(): void {
    // Rethrow scene render errors
    this.viewer.scene.rethrowRenderErrors = true;
    this.viewer.scene.renderError.addEventListener((scene: Scene, error: Error) => {
      console.error(scene, error);
      usePostHog().posthog.captureException(error);
    });

    // Proxy and log CesiumWidget render loop errors that only display a UI error message
    const widget = this.viewer.cesiumWidget;
    const proxied = widget.showErrorPanel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    widget.showErrorPanel = function widgetError(this: unknown, title: string, message: string, error: any) {
      proxied.apply(this, [title, message, error]);
      usePostHog().posthog.captureException(error);
    };
  }
}

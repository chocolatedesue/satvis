import { Cartesian3, Cartographic, Color, Credit, ImageryLayer, JulianDate, Math as CesiumMath, Matrix4, type Scene, SceneMode, ScreenSpaceEventHandler, ScreenSpaceEventType, TimeInterval, Transforms, defined } from "@cesium/engine";
import { Viewer } from "@cesium/widgets";
import { icon } from "@fortawesome/fontawesome-svg-core";
import { faBell, faInfo } from "@fortawesome/free-solid-svg-icons";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { usePostHog } from "../composables/usePostHog";
import { useToastProxy } from "../composables/useToastProxy";
import { useCesiumStore } from "../stores/cesium";
import { type ImageryProviderEntry, imageryProviders, type TerrainProviderEntry, terrainProviders } from "./CesiumLayerProviders";
import type { GroundStationPositionData } from "./GroundStationEntity";
import { SatelliteManager } from "./SatelliteManager";
import type { Pass } from "./SatelliteProperties";
import { CesiumPerformanceStats } from "./util/CesiumPerformanceStats";
import { DeviceDetect } from "./util/DeviceDetect";
import { PushManager } from "./util/PushManager";

import infoBoxOverrideCss from "../css/infobox.css?raw";
import infoBoxCss from "@cesium/widgets/Source/InfoBox/InfoBoxDescription.css?raw";

dayjs.extend(utc);

interface SerializedGroundStationInput {
  lat: number;
  lon: number;
  name?: string;
}

declare global {
  interface Window {
    cc?: CesiumController;
  }
}

export class CesiumController {
  viewer: Viewer;

  minimalUI: boolean;

  sats!: SatelliteManager;

  pm!: PushManager;

  sceneModes: string[] = [];

  cameraModes: string[] = [];

  activeLayers: string[] = [];

  performanceStats: CesiumPerformanceStats | undefined;

  oldBottomContainerStyleLeft: string = "";

  constructor() {
    this.preloadReferenceFrameData();
    this.minimalUI = DeviceDetect.inIframe() || DeviceDetect.isIos();

    this.viewer = new Viewer("cesiumContainer", {
      animation: !this.minimalUI,
      baseLayer: this.createImageryLayer("OfflineHighres"),
      baseLayerPicker: false,
      fullscreenButton: !this.minimalUI,
      fullscreenElement: document.body,
      geocoder: false,
      homeButton: false,
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

    // Export CesiumController for debugger
    window.cc = this;

    // CesiumController config
    this.sceneModes = ["3D", "2D", "Columbus"];
    this.cameraModes = ["Fixed", "Inertial"];

    this.createInputHandler();
    this.addErrorHandler();
    this.styleInfoBox();

    // Create Satellite Manager
    this.sats = new SatelliteManager(this.viewer);

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
    return Object.entries(imageryProviders)
      .filter(([, val]) => val.base)
      .map(([key]) => key);
  }

  get overlayLayers(): string[] {
    return Object.entries(imageryProviders)
      .filter(([, val]) => !val.base)
      .map(([key]) => key);
  }

  set imageryLayers(newLayerNames: string[]) {
    this.clearImageryLayers();
    newLayerNames.forEach((layerName) => {
      const [name, alphaStr] = layerName.split("_");
      const alpha = alphaStr === undefined ? undefined : Number(alphaStr);
      const layer = this.createImageryLayer(name as string, alpha);
      if (layer) {
        this.viewer.scene.imageryLayers.add(layer);
      }
    });
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
    return Object.entries(terrainProviders)
      .filter(([, val]) => val.visible ?? true)
      .map(([key]) => key);
  }

  set terrainProvider(terrainProviderName: string) {
    this.updateTerrainProvider(terrainProviderName);
  }

  async updateTerrainProvider(terrainProviderName: string): Promise<void> {
    if (!this.terrainProviderNames.includes(terrainProviderName)) {
      console.error("Unknown terrain provider");
      return;
    }

    const provider = await (terrainProviders[terrainProviderName] as TerrainProviderEntry).create();
    this.viewer.terrainProvider = provider;
  }

  set sceneMode(sceneMode: string) {
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

    if (this.sats.enabledComponents.includes("Orbit")) {
      this.sats.disableComponent("Orbit");

      const enableOrbits = (): void => {
        this.sats.enableComponent("Orbit");
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
    switch (cameraMode) {
      case "Inertial":
        this.viewer.scene.postUpdate.addEventListener(this.cameraTrackEci);
        break;
      case "Fixed":
        this.viewer.scene.postUpdate.removeEventListener(this.cameraTrackEci);
        break;
      default:
        console.error("Unknown camera mode");
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
    const didHitGlobe = defined(cartesian);
    if (didHitGlobe) {
      const cartographicPosition = Cartographic.fromCartesian(cartesian);
      const coordinates: GroundStationPositionData = {
        longitude: CesiumMath.toDegrees(cartographicPosition.longitude),
        latitude: CesiumMath.toDegrees(cartographicPosition.latitude),
        height: cartographicPosition.height,
        cartesian,
      };
      this.sats.addGroundStation(coordinates, "");
      useCesiumStore().pickMode = false;
    }
  }

  setGroundStationFromGeolocation(): void {
    navigator.geolocation.getCurrentPosition((position) => {
      if (typeof position === "undefined") {
        return;
      }
      const coordinates: GroundStationPositionData = {
        longitude: position.coords.longitude,
        latitude: position.coords.latitude,
        height: position.coords.altitude ?? 0,
        cartesian: Cartesian3.fromDegrees(position.coords.longitude, position.coords.latitude, position.coords.altitude ?? 0),
      };
      this.sats.addGroundStation(coordinates, "Geolocation");
    });
  }

  setGroundStationFromLatLon(lat: number, lon: number, height = 0): void {
    if (!lat || !lon) {
      return;
    }
    const coordinates: GroundStationPositionData = {
      longitude: lon,
      latitude: lat,
      height,
      cartesian: Cartesian3.fromDegrees(lon, lat, height),
    };
    this.sats.addGroundStation(coordinates, "");
  }

  setGroundStations(groundStations: SerializedGroundStationInput[]): void {
    if (!groundStations) {
      return;
    }
    const groundStationEntities = groundStations
      .filter((gs) => gs.lat && gs.lon)
      .map((gs) => {
        const coordinates: GroundStationPositionData = {
          longitude: gs.lon,
          latitude: gs.lat,
          height: 0,
          cartesian: Cartesian3.fromDegrees(gs.lon, gs.lat, 0),
        };
        return this.sats.createGroundstation(coordinates, gs.name ?? "");
      });
    this.sats.groundStations = groundStationEntities;
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

  styleInfoBox(): void {
    const infoBox = this.viewer.infoBox.container.getElementsByClassName("cesium-infoBox")[0];
    const close = this.viewer.infoBox.container.getElementsByClassName("cesium-infoBox-close")[0];
    if (infoBox && close) {
      // Container for additional buttons
      const container = document.createElement("div");
      container.setAttribute("class", "cesium-infoBox-container");
      infoBox.insertBefore(container, close);

      const notifyForPass = (pass: Pass, aheadMin = 5): void => {
        const start = dayjs(pass.start).startOf("second");
        this.pm.notifyAtDate(start.subtract(aheadMin, "minute").toDate(), `${pass.name} pass in ${aheadMin} minutes`);
        this.pm.notifyAtDate(start.toDate(), `${pass.name} pass starting now`);
      };

      // Notify button
      const notifyButton = document.createElement("button");
      notifyButton.setAttribute("type", "button");
      notifyButton.setAttribute("class", "cesium-button cesium-infoBox-custom");
      notifyButton.innerHTML = icon(faBell)?.html.join("") ?? "";
      notifyButton.addEventListener("click", () => {
        let passes: Pass[] = [];
        const toast = useToastProxy();
        if (!this.sats.groundStationAvailable) {
          toast.add({
            severity: "warn",
            summary: "Warning",
            detail: "Ground station required to notify for passes",
            life: 3000,
          });
          return;
        }
        const selectedGroundstation = this.sats.groundStations.find((gs) => gs.isSelected);
        if (this.sats.selectedSatellite) {
          passes = this.sats.getSatellite(this.sats.selectedSatellite)?.props.passes ?? [];
        } else if (selectedGroundstation) {
          passes = selectedGroundstation.passes(this.viewer.clock.currentTime);
        }
        if (!passes) {
          toast.add({
            severity: "info",
            summary: "Info",
            detail: `No passes available`,
            life: 3000,
          });
          return;
        }
        passes.forEach((pass) => notifyForPass(pass));
        toast.add({
          severity: "success",
          summary: "Success",
          detail: `Notifying for ${passes.length} passes`,
          life: 3000,
        });
      });
      container.appendChild(notifyButton);

      // Info button
      const infoButton = document.createElement("button");
      infoButton.setAttribute("type", "button");
      infoButton.setAttribute("class", "cesium-button cesium-infoBox-custom");
      infoButton.innerHTML = icon(faInfo)?.html.join("") ?? "";
      infoButton.addEventListener("click", () => {
        if (!this.sats.selectedSatellite) {
          return;
        }
        const sat = this.sats.getSatellite(this.sats.selectedSatellite);
        if (!sat) return;
        const { satnum } = sat.props;
        const url = `https://www.n2yo.com/satellite/?s=${satnum}`;
        window.open(url, "_blank", "noopener");
      });
      container.appendChild(infoButton);
    }

    const { frame } = this.viewer.infoBox;
    frame.addEventListener(
      "load",
      () => {
        // Inline infobox css as iframe does not use service worker
        const doc = frame.contentDocument;
        if (!doc) {
          return;
        }
        const { head } = doc;
        const links = head.getElementsByTagName("link");
        Array.from(links).forEach((link) => {
          head.removeChild(link);
        });
        const style = doc.createElement("style");
        const node = document.createTextNode(infoBoxCss + "\n" + infoBoxOverrideCss);
        style.appendChild(node);
        head.appendChild(style);
      },
      false,
    );

    // Allow js in infobox
    frame.setAttribute("sandbox", "allow-same-origin allow-popups allow-forms allow-scripts");
    frame.setAttribute("allowTransparency", "true");
    frame.src = "about:blank";

    // Allow time changes from infobox
    window.addEventListener("message", (e: MessageEvent) => {
      const pass = e.data;
      if (pass && typeof pass === "object" && "start" in pass) {
        this.setTime(pass.start);
      }
    });
  }
}

import type { Viewer } from "@cesium/widgets";
import { icon } from "@fortawesome/fontawesome-svg-core";
import { faBell, faInfo } from "@fortawesome/free-solid-svg-icons";
import dayjs from "dayjs";

import { useToastProxy } from "../../composables/useToastProxy";
import type { SatelliteManager } from "../SatelliteManager";
import type { Pass } from "../SatelliteProperties";

import infoBoxOverrideCss from "../../css/infobox.css?raw";
import infoBoxCss from "@cesium/widgets/Source/InfoBox/InfoBoxDescription.css?raw";

/**
 * Wires up the Cesium InfoBox: adds notify/info buttons, inlines the InfoBox
 * css into the sandboxed iframe (which bypasses the service worker), and bridges
 * `postMessage` time changes from pass links back to the controller.
 */
export class InfoBoxController {
  viewer: Viewer;

  sats: SatelliteManager;

  setTime: (time: string | number | Date) => void;

  notifyAtDate: (date: Date, message: string) => void;

  constructor(viewer: Viewer, sats: SatelliteManager, notifyAtDate: (date: Date, message: string) => void, setTime: (time: string | number | Date) => void) {
    this.viewer = viewer;
    this.sats = sats;
    this.notifyAtDate = notifyAtDate;
    this.setTime = setTime;
  }

  init(): void {
    this.addCustomButtons();
    this.inlineIframeCss();
    this.bridgeTimeChanges();
  }

  private notifyForPass(pass: Pass, aheadMin = 5): void {
    const start = dayjs(pass.start).startOf("second");
    this.notifyAtDate(start.subtract(aheadMin, "minute").toDate(), `${pass.name} pass in ${aheadMin} minutes`);
    this.notifyAtDate(start.toDate(), `${pass.name} pass starting now`);
  }

  private addCustomButtons(): void {
    const infoBox = this.viewer.infoBox.container.getElementsByClassName("cesium-infoBox")[0];
    const close = this.viewer.infoBox.container.getElementsByClassName("cesium-infoBox-close")[0];
    if (!infoBox || !close) {
      return;
    }

    // Container for additional buttons
    const container = document.createElement("div");
    container.setAttribute("class", "cesium-infoBox-container");
    infoBox.insertBefore(container, close);

    container.appendChild(this.createNotifyButton());
    container.appendChild(this.createInfoButton());
  }

  private createNotifyButton(): HTMLButtonElement {
    const notifyButton = document.createElement("button");
    notifyButton.setAttribute("type", "button");
    notifyButton.setAttribute("class", "cesium-button cesium-infoBox-custom");
    notifyButton.innerHTML = icon(faBell)?.html.join("") ?? "";
    notifyButton.addEventListener("click", () => {
      const toast = useToastProxy();
      if (!this.sats.groundStationAvailable) {
        toast.add({
          color: "warning",
          title: "Warning",
          description: "Ground station required to notify for passes",
          duration: 3000,
        });
        return;
      }
      let passes: Pass[] = [];
      const selectedGroundstation = this.sats.groundStations.find((gs) => gs.isSelected);
      if (this.sats.selectedSatellite) {
        passes = this.sats.getSatellite(this.sats.selectedSatellite)?.props.passes ?? [];
      } else if (selectedGroundstation) {
        passes = selectedGroundstation.passes(this.viewer.clock.currentTime);
      }
      if (passes.length === 0) {
        toast.add({
          color: "info",
          title: "Info",
          description: `No passes available`,
          duration: 3000,
        });
        return;
      }
      passes.forEach((pass) => this.notifyForPass(pass));
      toast.add({
        color: "success",
        title: "Success",
        description: `Notifying for ${passes.length} passes`,
        duration: 3000,
      });
    });
    return notifyButton;
  }

  private createInfoButton(): HTMLButtonElement {
    const infoButton = document.createElement("button");
    infoButton.setAttribute("type", "button");
    infoButton.setAttribute("class", "cesium-button cesium-infoBox-custom");
    infoButton.innerHTML = icon(faInfo)?.html.join("") ?? "";
    infoButton.addEventListener("click", () => {
      if (!this.sats.selectedSatellite) {
        return;
      }
      const sat = this.sats.getSatellite(this.sats.selectedSatellite);
      if (!sat) {
        return;
      }
      const { satnum } = sat.props;
      window.open(`https://www.n2yo.com/satellite/?s=${satnum}`, "_blank", "noopener");
    });
    return infoButton;
  }

  private inlineIframeCss(): void {
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
  }

  private bridgeTimeChanges(): void {
    // Allow time changes from infobox pass links
    window.addEventListener("message", (e: MessageEvent) => {
      const pass = e.data;
      if (pass && typeof pass === "object" && "start" in pass) {
        this.setTime(pass.start);
      }
    });
  }
}

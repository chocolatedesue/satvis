// Whether the sky view is aiming by the device's compass.
//
// Module-scoped state, because the control that flips it and the note that
// reports on it are in different component subtrees: the toggle lives in the
// View menu (Satvis.vue) and the "hold the phone flat" note lives on the HUD.
//
// The outcomes are all reported, not just failure. A compass that turns on and
// aims at the wrong sky is worse than one that declines to turn on, so
// `no-heading` is a refusal — see docs/adr/0004-compass-aiming.md.

import { readonly, type Ref, ref } from "vue";

import type { CesiumController } from "../modules/CesiumController";
import type { CompassOutcome } from "../modules/SkyInteraction";
import { useToastProxy } from "./useToastProxy";

/**
 * Whether to offer the control at all. The sensor needs a secure context, so
 * over plain http there is nothing to offer and no point saying why.
 */
export const compassAvailable = (): boolean => typeof DeviceOrientationEvent !== "undefined" && window.isSecureContext;

const active = ref(false);
const pending = ref(false);

const FAILURES: Record<string, string> = {
  unsupported: "This browser does not report device orientation.",
  denied: "Motion and orientation access was declined. It can be re-enabled in the browser's site settings.",
  silent: "Orientation was granted but no readings arrived, which is usual on a device without motion sensors.",
  no_heading: "This device reports orientation but cannot tell where north is, so the sky would be aimed at an arbitrary bearing.",
};

export function useSkyCompass(cc: CesiumController): { active: Readonly<Ref<boolean>>; pending: Readonly<Ref<boolean>>; toggle: () => Promise<void>; stopped: () => void } {
  async function toggle(): Promise<void> {
    const { skyInteraction } = cc;
    if (active.value) {
      skyInteraction.disableDeviceOrientation();
      active.value = false;
      return;
    }
    if (pending.value) {
      return;
    }

    // Enabling takes a moment — iOS raises a permission prompt, and every platform
    // gets a sensor probe it has to answer — so the control has something to say
    // while it waits rather than looking inert.
    pending.value = true;
    let outcome: CompassOutcome;
    try {
      outcome = await skyInteraction.enableDeviceOrientation();
    } finally {
      pending.value = false;
    }
    active.value = outcome === "aiming" || outcome === "aiming-uncalibrated";

    if (outcome === "aiming-uncalibrated") {
      // iOS only reports a heading worth believing while the screen is near
      // horizontal, so north is not known until the phone has been flat once.
      // Until then the aim follows the device against an arbitrary zero, which
      // the HUD also says for as long as it lasts.
      useToastProxy().add({
        title: "Aiming by compass",
        description: "Hold the phone flat for a moment to set north.",
        color: "info",
      });
      return;
    }
    if (outcome === "aiming") {
      return;
    }
    useToastProxy().add({
      title: "Compass aiming unavailable",
      description: FAILURES[outcome.replace("-", "_")] ?? "The device's orientation is not usable for aiming.",
      color: "warning",
    });
  }

  /** The sky view closed, taking the sensor subscription with it. */
  function stopped(): void {
    active.value = false;
  }

  return { active: readonly(active), pending: readonly(pending), toggle, stopped };
}

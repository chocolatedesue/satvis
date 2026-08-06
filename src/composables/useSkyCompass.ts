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

export function useSkyCompass(cc: CesiumController): { active: Readonly<Ref<boolean>>; pending: Readonly<Ref<boolean>>; toggle: () => Promise<void> } {
  // The control is not the only thing that can switch the compass off — a drag
  // takes the aim back, and the view closing stops the sensor — so it listens as
  // well as writes, and there is no second "and now tell the control" call for a
  // caller to forget. Registered on every call rather than once: the callback is
  // a single slot and this closure is the same thing however many components ask
  // for the compass.
  cc.skyInteraction.onOrientationStop(() => {
    active.value = false;
  });

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
    const aiming = outcome === "aiming" || outcome === "aiming-uncalibrated";
    active.value = aiming;

    if (aiming) {
      // Said on every successful enable, not only on the uncalibrated one, and
      // the reason is the way out rather than the calibration: this is the one
      // moment the app has the user's attention on compass aiming, a drag turns
      // it off, and that is the gesture somebody who dislikes the compass will
      // try anyway. "Drag", not "take the aim back" — what they do is drag, and
      // what they want to know is that it is allowed. A device that already knows
      // north — Android's absolute reading — needs that sentence just as much,
      // and used to get no toast at all.
      //
      // The calibration half only applies to the other outcome: iOS reports a
      // heading worth believing only while the screen is near horizontal, so
      // north is not known until the phone has been flat once. The HUD says so
      // too, for as long as it lasts.
      const calibration = outcome === "aiming-uncalibrated" ? "Hold the phone flat for a moment to set north. " : "";
      useToastProxy().add({
        title: "Aiming by compass",
        description: `${calibration}Drag at any time to turn the compass off.`,
        color: "info",
      });
      return;
    }
    if (outcome === "taken-back") {
      // Nothing failed, and the user is the one who ended it — by dragging while
      // the sensor was still proving itself — so a warning would be telling them
      // what they just did.
      return;
    }
    useToastProxy().add({
      title: "Compass aiming unavailable",
      description: FAILURES[outcome.replace("-", "_")] ?? "The device's orientation is not usable for aiming.",
      color: "warning",
    });
  }

  return { active: readonly(active), pending: readonly(pending), toggle };
}

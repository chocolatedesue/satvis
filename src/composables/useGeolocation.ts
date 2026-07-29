// Asking the device where it is.
//
// Two exports, for two kinds of caller. `currentPosition` is the primitive: a
// plain promise, for the places that are not components — `sceneSync` resolving the
// sky view's observer, and CesiumController. `useGeolocation` wraps it for the
// places that are, adding the one thing a component needs and a promise cannot give
// it: a reactive flag saying a fix is in flight.
//
// The state is module-scoped rather than per-caller because there is one device.
// Two components asking must see the same answer about whether it is busy.
//
// Deliberately not VueUse's `useGeolocation`, which wraps `watchPosition` and hands
// coordinates back as refs: every caller here wants one fix, awaited, with a refusal
// it can act on, and a standing position watch would cost battery and leave the
// platform's location indicator lit for a value read once.
//
// Note that this needs a secure context: over plain http on a LAN address the api is
// either absent or refuses, so `pnpm dev:host` cannot exercise it.

import { readonly, type Ref, ref } from "vue";

import type { Observer } from "../modules/skyGeometry";

// Long, because a cold fix genuinely takes this long. Cutting it short would turn a
// slow success into a false failure, which is why the wait is worth showing in the
// ui rather than shortening.
const TIMEOUT_MS = 10_000;

/**
 * The device's position, or undefined when the user declines, the fix fails, or it
 * times out.
 *
 * `navigator.geolocation` predates promises and reports failure through a second
 * callback, which is awkward for a caller that has to decide whether to carry on —
 * the sky view will not open without an observer, so it has to await an answer
 * rather than fire and forget. Going through here rather than calling the api
 * directly is also what makes a refusal reportable: the second callback is easy to
 * leave out, and a geolocation button that silently does nothing when permission is
 * declined is indistinguishable from a broken one.
 */
export async function currentPosition(): Promise<Observer | undefined> {
  if (!navigator.geolocation) {
    return undefined;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
      (error) => {
        console.warn(`Geolocation unavailable: ${error.message}`);
        resolve(undefined);
      },
      { timeout: TIMEOUT_MS },
    );
  });
}

const pending = ref(false);

/** A location request a component can drive, and say something about while it waits. */
export function useGeolocation(): { pending: Readonly<Ref<boolean>>; locate: () => Promise<void> } {
  async function locate(): Promise<void> {
    if (pending.value) {
      return;
    }
    pending.value = true;
    try {
      // Through the controller rather than writing the store from here: it owns the
      // ground station write and the name that goes on it, so there is still exactly
      // one writer of ground stations.
      await globalThis.cc.setGroundStationFromGeolocation();
    } finally {
      pending.value = false;
    }
  }

  return { pending: readonly(pending), locate };
}

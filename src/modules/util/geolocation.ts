// The browser's location, as a promise. The only way this app asks.
//
// `navigator.geolocation` predates promises and reports failure through a second
// callback, which is awkward for a caller that has to decide whether to carry on
// — the sky view will not open without an observer, so it has to await an answer
// rather than fire and forget. Going through here rather than calling the api
// directly is also what makes a refusal reportable: the second callback is easy
// to leave out, and a geolocation button that silently does nothing when
// permission is declined is indistinguishable from a broken one.
//
// Deliberately not VueUse's `useGeolocation`, which wraps `watchPosition` and
// hands back refs: every caller here wants one fix, awaited, with a refusal it
// can act on, and a standing position watch would cost battery and leave the
// platform's location indicator lit for a value read once.
//
// Note that this needs a secure context: over plain http on a LAN address the
// api is either absent or refuses, so `pnpm dev:host` cannot exercise it.

import type { Observer } from "../skyGeometry";

const TIMEOUT_MS = 10_000;

/** Resolves to undefined when the user declines, the fix fails, or it times out. */
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

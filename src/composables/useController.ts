// How a component reaches the CesiumController.
//
// It used to be `globalThis.cc`, set by the controller's own constructor. Eight
// modules bound to that, and none of the edges were visible to the type checker
// or replaceable in a test. app.ts now provides the instance it built and every
// consumer either injects it here or takes it as an argument.
//
// `window.cc` still exists as a console handle for debugging (set in app.ts),
// but nothing in the app reads it.

import { inject, type InjectionKey } from "vue";

import type { CesiumController } from "../modules/CesiumController";

export const controllerKey: InjectionKey<CesiumController> = Symbol("cesiumController");

/**
 * The controller this app was built around. Throws rather than returning
 * undefined: a component rendered outside the provide is a wiring mistake, and
 * every call site would otherwise carry the same non-null assertion.
 */
export function useController(): CesiumController {
  const cc = inject(controllerKey);
  if (!cc) {
    throw new Error("No CesiumController provided — app.ts must provide(controllerKey, cc) before mounting.");
  }
  return cc;
}

// Toast utility for use in non-Vue contexts
// This allows CesiumController and other plain JS classes to show toast notifications

import type { useToast } from "@nuxt/ui/composables/useToast";

type ToastApi = ReturnType<typeof useToast>;
type ToastMessage = Parameters<ToastApi["add"]>[0];

let toast: ToastApi | null = null;

// Messages raised before App.vue mounted, held rather than dropped. Startup work
// finishes on either side of mount — the imagery availability probe resolves in
// a millisecond from cache — and a warning that lands on the early side is
// exactly the one worth keeping.
const pending: ToastMessage[] = [];

export function initToastProxy(t: ToastApi): ToastApi {
  toast = t;
  for (const message of pending.splice(0)) {
    t.add(message);
  }
  return t;
}

// Returns the real toast service once initialized, and until then a buffer that
// replays into it.
export const useToastProxy = (): ToastApi | { add: (message: ToastMessage) => void } =>
  toast ?? {
    add: (message: ToastMessage) => {
      pending.push(message);
    },
  };

// Toasting from outside a Vue component, for CesiumController and the other
// plain classes that have no `useToast` to reach for.

import type { useToast } from "@nuxt/ui/composables/useToast";

type ToastApi = ReturnType<typeof useToast>;
type ToastMessage = Parameters<ToastApi["add"]>[0];

let toast: ToastApi | null = null;

export const initToastProxy = (t: ToastApi): ToastApi => (toast = t);

// Returns a real toast service when initialized, or a no-op fallback that warns once.
// Everything that toasts does so in response to a user action, well after App.vue
// has mounted, so the fallback is a bug report rather than a path to design for.
export const useToastProxy = (): ToastApi | { add: (message: ToastMessage) => void } => toast ?? { add: () => console.warn("Toast not initialized") };

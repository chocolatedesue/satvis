// Toast utility for use in non-Vue contexts
// This allows CesiumController and other plain JS classes to show toast notifications

import type { useToast } from "@nuxt/ui/composables/useToast";

type ToastApi = ReturnType<typeof useToast>;
type ToastMessage = Parameters<ToastApi["add"]>[0];

let toast: ToastApi | null = null;

export const initToastProxy = (t: ToastApi): ToastApi => (toast = t);

// Returns a real toast service when initialized, or a no-op fallback that warns once.
export const useToastProxy = (): ToastApi | { add: (message: ToastMessage) => void } => toast ?? { add: () => console.warn("Toast not initialized") };

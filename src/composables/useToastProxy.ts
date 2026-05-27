// Toast utility for use in non-Vue contexts
// This allows CesiumController and other plain JS classes to show toast notifications

import type { ToastMessageOptions } from "primevue/toast";
import type { ToastServiceMethods } from "primevue/toastservice";

let toast: ToastServiceMethods | null = null;

export const initToastProxy = (t: ToastServiceMethods): ToastServiceMethods => (toast = t);

// Returns a real toast service when initialized, or a no-op fallback that warns once.
export const useToastProxy = (): ToastServiceMethods | { add: (message: ToastMessageOptions) => void } => toast ?? { add: () => console.warn("Toast not initialized") };

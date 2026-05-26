// Toast utility for use in non-Vue contexts
// This allows CesiumController and other plain JS classes to show toast notifications

import type { ToastServiceMethods } from "primevue/toastservice";

let toast: ToastServiceMethods | null = null;

export const initToastProxy = (t: ToastServiceMethods): ToastServiceMethods => (toast = t);

// Returns a real toast service when initialized, or a no-op fallback that warns once.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useToastProxy = (): ToastServiceMethods | { add: (...args: any[]) => void } => toast ?? { add: () => console.warn("Toast not initialized") };

import { registerSW } from "virtual:pwa-register";
import { ref } from "vue";

interface UsePWAUpdateOptions {
  /**
   * Whether to automatically reload the app when a new version is detected.
   * @default false
   */
  autoUpdate?: boolean;
  /**
   * Interval in seconds to check for updates.
   * Set to 0 to disable periodic checks.
   * @default 86400 (24 hours)
   */
  updateInterval?: number;
}

// Singleton state — shared across all callers
const needRefresh = ref(false);
const offlineReady = ref(false);
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
let registered = false;
let intervalId: ReturnType<typeof setInterval> | undefined;

/**
 * Composable for managing PWA service worker updates.
 *
 * State is shared (singleton) across all callers. The service worker is registered immediately on the first call.
 *
 * @param options - Configuration options
 * @returns Object containing PWA update state and methods
 *
 * @example
 * // Automatic updates
 * const { needRefresh } = usePWAUpdate({ autoUpdate: true });
 *
 * @example
 * // Manual updates with UI notification
 * const { needRefresh, updateApp } = usePWAUpdate();
 * // In your component, watch needRefresh and show update prompt
 * watch(needRefresh, (value) => {
 *   if (value) {
 *     // Show toast/dialog asking user to update
 *     updateApp(); // Call this when user confirms
 *   }
 * });
 */
export function usePWAUpdate(options: UsePWAUpdateOptions = {}) {
  const { autoUpdate = false, updateInterval = 60 * 60 * 24 } = options;

  const updateApp = async () => {
    if (updateSW) {
      try {
        await updateSW(true);
        needRefresh.value = false;
      } catch (error) {
        console.error("PWA: Failed to update app:", error);
      }
    }
  };

  // Register the service worker exactly once
  if (!registered) {
    registered = true;

    updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        console.log("PWA: Update available - need refresh");
        needRefresh.value = true;

        if (autoUpdate) {
          console.log("PWA: Auto-update enabled, updating app...");
          updateApp();
        }
      },
      onOfflineReady() {
        console.log("PWA: App is ready to work offline");
        offlineReady.value = true;
      },
      onRegistered(registration: ServiceWorkerRegistration | undefined) {
        console.log("PWA: Service worker registered successfully");

        // Set up periodic update checks (only once)
        if (registration && updateInterval > 0 && !intervalId) {
          intervalId = setInterval(() => {
            console.log("PWA: Checking for updates...");
            registration.update();
          }, updateInterval * 1000);
        }
      },
      onRegisterError(error: Error) {
        console.error("PWA: Service worker registration error:", error);
      },
    });
  }

  return {
    needRefresh,
    offlineReady,
    updateApp,
  };
}

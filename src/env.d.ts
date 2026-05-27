/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { CesiumController } from "./modules/CesiumController";

declare global {
  const __BUILD_DATE__: string;
  const __BUILD_SHA__: string;
  // eslint-disable-next-line no-var
  var cc: CesiumController;
}

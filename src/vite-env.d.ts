/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import type { CesiumController } from "./modules/CesiumController";

declare global {
  const __BUILD_DATE__: string;
  const __BUILD_SHA__: string;
  /**
   * How deep the base map goes in *this* build: 5 when `pnpm update-imagery` has
   * produced levels 3-5, otherwise 2, the deepest committed level. Decided in
   * vite.config.ts, because whether those tiles ship is a property of the build.
   */
  const __IMAGERY_MAX_LEVEL__: number;
  // eslint-disable-next-line no-var
  var cc: CesiumController;
}

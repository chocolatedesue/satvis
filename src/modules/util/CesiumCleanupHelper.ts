import type { Viewer } from "@cesium/widgets";

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

export class CesiumCleanupHelper {
  // Cleanup leftover Cesium internal data after removing satellites
  // https://github.com/CesiumGS/cesium/issues/7184
  static cleanup(viewer: Viewer): void {
    const onTickEventRemovalCallback = CesiumCallbackHelper.createPeriodicTickCallback(viewer, 1, () => {
      console.info("Removing leftover Cesium internal data");
      onTickEventRemovalCallback();

      // Walk Cesium's internal primitive/label/billboard graph - none of these
      // underscore-prefixed members are part of the public type definitions.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const primitives = viewer.scene.primitives as any;
      const labelCollection = primitives?._primitives[0]?._primitives[0]?._primitives[0]?._labelCollection;
      const spareBillboards = labelCollection?._spareBillboards;
      const billboardCollection = labelCollection?._billboardCollection;

      if (spareBillboards && billboardCollection) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spareBillboards.forEach((billboard: any) => {
          billboardCollection.remove(billboard);
        });
        spareBillboards.length = 0;
      }
    });
  }
}

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Viewer = any;

export class CesiumCleanupHelper {
  // Cleanup leftover Cesium internal data after removing satellites
  // https://github.com/CesiumGS/cesium/issues/7184
  static cleanup(viewer: Viewer): void {
    const onTickEventRemovalCallback = CesiumCallbackHelper.createPeriodicTickCallback(viewer, 1, () => {
      console.info("Removing leftover Cesium internal data");
      onTickEventRemovalCallback();

      const primitives = viewer.scene.primitives;
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

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

export class CesiumCleanupHelper {
  // Cleanup leftover Cesium internal data after removing satellites
  // https://github.com/CesiumGS/cesium/issues/7184
  static cleanup(viewer) {
    const onTickEventRemovalCallback = CesiumCallbackHelper.createPeriodicTickCallback(viewer, 1, () => {
      console.info("Removing leftover Cesium internal data");
      onTickEventRemovalCallback();

      const primitives = viewer.scene.primitives;
      const labelCollection = primitives?._primitives[0]?._primitives[0]?._primitives[0]?._labelCollection;
      const spareBillboards = labelCollection?._spareBillboards;
      const billboardCollection = labelCollection?._billboardCollection;

      if (spareBillboards && billboardCollection) {
        spareBillboards.forEach((billboard) => {
          billboardCollection.remove(billboard);
        });
        spareBillboards.length = 0;
      }
    });
  }
}

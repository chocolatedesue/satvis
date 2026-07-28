// `deviceorientationabsolute` is Chrome's earth-referenced orientation event and
// the only source of true north on Android. It is not in lib.dom, so a listener
// for it does not type-check without this.

interface WindowEventMap {
  deviceorientationabsolute: DeviceOrientationEvent;
}

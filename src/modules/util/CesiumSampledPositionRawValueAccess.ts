import { SampledPositionProperty, binarySearch, JulianDate } from "@cesium/engine";

// Augment Cesium's SampledPositionProperty with custom raw value accessors.
declare module "@cesium/engine" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SampledPositionProperty {
    getRawValues(start: JulianDate, end: JulianDate): unknown[];
    length(): number;
  }
}

/**
 * Gets the original values stored in the sampled property for the provided timeframe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SampledPositionProperty.prototype as any).getRawValues = function (this: any, start: JulianDate, end: JulianDate): unknown[] {
  const times = this._property._times;
  if (times.length === 0) {
    return [];
  }
  const innerType = this._property._innerType;
  const values = this._property._values;

  let startIndex = binarySearch(times, start, JulianDate.compare);
  let endIndex = binarySearch(times, end, JulianDate.compare);
  if (startIndex < 0) {
    startIndex = ~startIndex;
  }
  if (endIndex < 0) {
    endIndex = ~endIndex;
  }
  const result: unknown[] = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    result.push(innerType.unpack(values, i * innerType.packedLength));
  }
  return result;
};

/**
 * Gets the number of samples stored in the sampled property.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SampledPositionProperty.prototype as any).length = function (this: any): number {
  return this._property._times.length;
};

import {
  Cartesian3,
  ExtrapolationType,
  JulianDate,
  LagrangePolynomialApproximation,
  Matrix3,
  ReferenceFrame,
  SampledPositionProperty,
  TimeInterval,
  Transforms,
  defined,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type Orbit from "./Orbit";
import "./util/CesiumSampledPositionRawValueAccess";
import { CesiumCallbackHelper } from "./util/CesiumCallbackHelper";

interface SampledPositionData {
  interval: TimeInterval;
  fixed: SampledPositionProperty;
  inertial: SampledPositionProperty;
  valid: boolean;
}

/**
 * The single owner of the sampled position for one satellite: the sliding
 * sample window (half an orbit back, 1.5 forward), gap-filling and eviction
 * as time advances, and the fixed/inertial frame duality.
 *
 * Consumers subscribe via `start()` and read positions through the accessors;
 * nothing outside this module touches the sample bookkeeping.
 */
export class SampledTrajectory {
  #orbit: Orbit;

  #data: SampledPositionData | undefined;

  constructor(orbit: Orbit) {
    this.#orbit = orbit;
  }

  /** Whether samples exist and propagation has not failed. */
  get valid(): boolean {
    return this.#data?.valid ?? false;
  }

  /** Fixed-frame sampled position for entity binding. */
  get fixed(): SampledPositionProperty | undefined {
    return this.#data?.fixed;
  }

  /** Inertial-frame (ICRF) sampled position for orbit visualization. */
  get inertial(): SampledPositionProperty | undefined {
    return this.#data?.inertial;
  }

  /** The time interval currently covered by samples. */
  get interval(): TimeInterval | undefined {
    return this.#data?.interval;
  }

  /** Fixed-frame position at `time`, interpolated from the samples. */
  position(time: JulianDate): Cartesian3 | undefined {
    return this.#data?.fixed.getValue(time);
  }

  positionsForNextOrbit(start: JulianDate, reference: "inertial" | "fixed" = "inertial", loop = true): unknown[] {
    if (!this.#data) return [];
    const end = JulianDate.addSeconds(start, this.#orbit.orbitalPeriod * 60, new JulianDate());
    const positions = this.#data[reference].getRawValues(start, end);
    if (loop) {
      // Readd the first position to the end of the array to close the loop
      return [...positions, positions[0]];
    }
    return positions;
  }

  groundTrack(julianDate: JulianDate, samplesFwd = 1, samplesBwd = 0, interval = 300): (Cartesian3 | undefined)[] {
    const groundTrack: (Cartesian3 | undefined)[] = [];

    const startTime = -samplesBwd * interval;
    const stopTime = samplesFwd * interval;
    for (let time = startTime; time <= stopTime; time += interval) {
      const timestamp = JulianDate.addSeconds(julianDate, time, new JulianDate());
      groundTrack.push(this.position(timestamp));
    }
    return groundTrack;
  }

  /**
   * Populate samples for the viewer's current time and keep them fresh with a
   * periodic clock callback; `callback` fires after every refresh. Returns an
   * unsubscribe function that also tears down the samples.
   */
  start(viewer: Viewer, callback: () => void): () => void {
    this.update(viewer.clock.currentTime);
    callback();

    const samplingRefreshRate = (this.#orbit.orbitalPeriod * 60) / 4;
    const removeCallback = CesiumCallbackHelper.createPeriodicTimeCallback(viewer, samplingRefreshRate, (time) => {
      this.update(time);
      callback();
    });
    return () => {
      removeCallback();
      this.#data = undefined;
    };
  }

  update(time: JulianDate): void {
    // Determine sampling interval based on sampled positions per orbit and orbital period
    // 120 samples per orbit seems to be a good compromise between performance and accuracy
    const samplingPointsPerOrbit = 120;
    const orbitalPeriod = this.#orbit.orbitalPeriod * 60;
    const samplingInterval = orbitalPeriod / samplingPointsPerOrbit;

    // Always keep half an orbit backwards and 1.5 full orbits forward in the sampled position
    const request = new TimeInterval({
      start: JulianDate.addSeconds(time, -orbitalPeriod / 2, new JulianDate()),
      stop: JulianDate.addSeconds(time, orbitalPeriod * 1.5, new JulianDate()),
    });

    // (Re)create sampled position if it does not exist or if it does not contain the current time
    if (!this.#data || !TimeInterval.contains(this.#data.interval, time)) {
      this.#init(request.start);
    }
    const sp = this.#data as SampledPositionData;

    // Determine which parts of the requested interval are missing
    const intersect = TimeInterval.intersect(sp.interval, request, new TimeInterval());
    const missingSecondsEnd = JulianDate.secondsDifference(request.stop, intersect.stop);
    const missingSecondsStart = JulianDate.secondsDifference(intersect.start, request.start);

    if (missingSecondsStart > 0) {
      const samplingStart = JulianDate.addSeconds(intersect.start, -missingSecondsStart, new JulianDate());
      const samplingStop = sp.interval.start;
      this.#addSamples(samplingStart, samplingStop, samplingInterval);
    }
    if (missingSecondsEnd > 0) {
      const samplingStart = sp.interval.stop;
      const samplingStop = JulianDate.addSeconds(intersect.stop, missingSecondsEnd, new JulianDate());
      this.#addSamples(samplingStart, samplingStop, samplingInterval);
    }

    // Remove no longer needed samples
    const removeBefore = new TimeInterval({
      start: JulianDate.fromIso8601("1957"),
      stop: request.start,
      isStartIncluded: false,
      isStopIncluded: false,
    });
    const removeAfter = new TimeInterval({
      start: request.stop,
      stop: JulianDate.fromIso8601("2100"),
      isStartIncluded: false,
      isStopIncluded: false,
    });
    sp.fixed.removeSamples(removeBefore);
    sp.inertial.removeSamples(removeBefore);
    sp.fixed.removeSamples(removeAfter);
    sp.inertial.removeSamples(removeAfter);

    sp.interval = request;
  }

  #init(currentTime: JulianDate): void {
    const fixed = new SampledPositionProperty();
    fixed.backwardExtrapolationType = ExtrapolationType.HOLD;
    fixed.forwardExtrapolationType = ExtrapolationType.HOLD;
    fixed.setInterpolationOptions({
      interpolationDegree: 5,
      interpolationAlgorithm: LagrangePolynomialApproximation,
    });
    const inertial = new SampledPositionProperty(ReferenceFrame.INERTIAL);
    inertial.backwardExtrapolationType = ExtrapolationType.HOLD;
    inertial.forwardExtrapolationType = ExtrapolationType.HOLD;
    inertial.setInterpolationOptions({
      interpolationDegree: 5,
      interpolationAlgorithm: LagrangePolynomialApproximation,
    });
    this.#data = {
      interval: new TimeInterval({
        start: currentTime,
        stop: currentTime,
        isStartIncluded: false,
        isStopIncluded: false,
      }),
      fixed,
      inertial,
      valid: true,
    };
  }

  #addSamples(start: JulianDate, stop: JulianDate, samplingInterval: number): void {
    if (!this.#data) return;
    const times: JulianDate[] = [];
    const positionsFixed: Cartesian3[] = [];
    const positionsInertial: Cartesian3[] = [];
    for (let time = start; JulianDate.compare(stop, time) >= 0; time = JulianDate.addSeconds(time, samplingInterval, new JulianDate())) {
      const { positionFixed, positionInertial } = this.#computePosition(time);
      times.push(time);
      positionsFixed.push(positionFixed);
      positionsInertial.push(positionInertial);
    }
    // Add all samples at once as adding a sorted array avoids searching for the correct position every time
    this.#data.fixed.addSamples(times, positionsFixed);
    this.#data.inertial.addSamples(times, positionsInertial);
  }

  #computePositionInertialTEME(time: JulianDate): Cartesian3 {
    const eci = this.#orbit.positionECI(JulianDate.toDate(time));
    if (this.#orbit.error || !eci) {
      if (this.#data) this.#data.valid = false;
      return Cartesian3.ZERO;
    }
    return new Cartesian3(eci.x * 1000, eci.y * 1000, eci.z * 1000);
  }

  #computePosition(timestamp: JulianDate): { positionFixed: Cartesian3; positionInertial: Cartesian3 } {
    const positionInertialTEME = this.#computePositionInertialTEME(timestamp);

    const temeToFixed = Transforms.computeTemeToPseudoFixedMatrix(timestamp);
    if (!defined(temeToFixed)) {
      console.error("Reference frame transformation data failed to load");
    }
    const positionFixed = Matrix3.multiplyByVector(temeToFixed, positionInertialTEME, new Cartesian3());

    const fixedToIcrf = Transforms.computeFixedToIcrfMatrix(timestamp);
    if (!defined(fixedToIcrf)) {
      console.error("Reference frame transformation data failed to load");
    }
    const positionInertialICRF = Matrix3.multiplyByVector(fixedToIcrf as Matrix3, positionFixed, new Cartesian3());

    return { positionFixed, positionInertial: positionInertialICRF };
  }
}

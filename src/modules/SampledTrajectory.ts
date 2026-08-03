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
import type { InterpolationAlgorithm } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type Orbit from "./Orbit";
import "./util/CesiumSampledPositionRawValueAccess";
import { CesiumCallbackHelper } from "./util/CesiumCallbackHelper";

// Cesium 1.143 widened the InterpolationAlgorithm interface (type/interpolate) without
// updating the LagrangePolynomialApproximation namespace declaration; the runtime object
// satisfies the interface, so bridge the upstream typings gap with a cast.
const lagrangeInterpolation = LagrangePolynomialApproximation as unknown as InterpolationAlgorithm;

interface SampledPositionData {
  interval: TimeInterval;
  fixed: SampledPositionProperty;
  /**
   * Absent until something asks for it. Only the Orbit component reads the
   * inertial frame, and carrying a second full sample set for every satellite in
   * a scene that never draws one measured 8.7 KB a satellite — 43 MB across five
   * thousand. See `requireInertial`.
   */
  inertial: SampledPositionProperty | undefined;
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

  /** Whether any consumer has asked for the inertial frame. See requireInertial. */
  #wantsInertial = false;

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

  /**
   * Inertial-frame (ICRF) sampled position for orbit visualization.
   *
   * Call `requireInertial` first. Reading this without doing so returns undefined
   * on a trajectory that has never been asked for the inertial frame, rather than
   * quietly building one — the point of the flag is that the cost is opted into.
   */
  get inertial(): SampledPositionProperty | undefined {
    return this.#data?.inertial;
  }

  /**
   * Declare that the inertial frame is needed, and make it so.
   *
   * Idempotent, and safe to call before or after `start`: the flag makes every
   * later refresh sample both frames, and if a window is already up its inertial
   * half is backfilled from the fixed samples already in it. That backfill is a
   * frame transform per sample and no SGP4 — the propagation has already been
   * paid for, and only the rotation into ICRF is missing.
   */
  requireInertial(): void {
    if (this.#wantsInertial) {
      return;
    }
    this.#wantsInertial = true;
    this.#backfillInertial();
  }

  #backfillInertial(): void {
    const data = this.#data;
    if (!data || data.inertial) {
      return;
    }
    const inertial = SampledTrajectory.#createProperty(ReferenceFrame.INERTIAL);
    const { times, values } = data.fixed.getRawSamples();
    const positions: Cartesian3[] = [];
    const kept: JulianDate[] = [];
    for (const [index, time] of times.entries()) {
      const fixedToIcrf = Transforms.computeFixedToIcrfMatrix(time);
      if (!defined(fixedToIcrf)) {
        continue;
      }
      kept.push(time);
      positions.push(Matrix3.multiplyByVector(fixedToIcrf, values[index] as Cartesian3, new Cartesian3()));
    }
    if (kept.length > 0) {
      inertial.addSamples(kept, positions);
    }
    data.inertial = inertial;
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
    if (reference === "inertial") {
      // The caller wants the inertial frame, which is the declaration itself.
      this.requireInertial();
    }
    const property = this.#data[reference];
    if (!property) return [];
    const end = JulianDate.addSeconds(start, this.#orbit.orbitalPeriod * 60, new JulianDate());
    const positions = property.getRawValues(start, end);
    if (loop) {
      // Readd the first position to the end of the array to close the loop
      return [...positions, positions[0]];
    }
    return positions;
  }

  /**
   * The Earth-relative path one full orbit ahead of `start`, for the Orbit track.
   *
   * The raw stored samples rather than a resampling: they are already there, and
   * at 120 a revolution they draw a track no coarser than the position the
   * satellite is itself interpolated from. Only the head is computed, because
   * the first stored sample can sit up to a sampling interval (about 45 s, some
   * 350 km) ahead of the satellite, and a gold line that visibly starts in front
   * of the point it belongs to is the one artefact of batching that a viewer
   * would read as a bug rather than as a level of detail.
   */
  positionsForTrack(start: JulianDate): Cartesian3[] {
    if (!this.#data) return [];
    const end = JulianDate.addSeconds(start, this.#orbit.orbitalPeriod * 60, new JulianDate());
    const head = this.position(start);
    const samples = this.#data.fixed.getRawValues(start, end) as Cartesian3[];
    return head ? [head, ...samples] : samples;
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
    sp.fixed.removeSamples(removeAfter);
    sp.inertial?.removeSamples(removeBefore);
    sp.inertial?.removeSamples(removeAfter);

    sp.interval = request;
  }

  /** Both frames want the same extrapolation and interpolation; only the frame differs. */
  static #createProperty(referenceFrame?: ReferenceFrame): SampledPositionProperty {
    const property = new SampledPositionProperty(referenceFrame);
    property.backwardExtrapolationType = ExtrapolationType.HOLD;
    property.forwardExtrapolationType = ExtrapolationType.HOLD;
    property.setInterpolationOptions({
      interpolationDegree: 5,
      interpolationAlgorithm: lagrangeInterpolation,
    });
    return property;
  }

  #init(currentTime: JulianDate): void {
    this.#data = {
      interval: new TimeInterval({
        start: currentTime,
        stop: currentTime,
        isStartIncluded: false,
        isStopIncluded: false,
      }),
      fixed: SampledTrajectory.#createProperty(),
      // Only if something has already asked. A re-init mid-life keeps whatever
      // the trajectory was already committed to sampling.
      inertial: this.#wantsInertial ? SampledTrajectory.#createProperty(ReferenceFrame.INERTIAL) : undefined,
      valid: true,
    };
  }

  #addSamples(start: JulianDate, stop: JulianDate, samplingInterval: number): void {
    if (!this.#data) return;
    const inertialProperty = this.#data.inertial;
    const times: JulianDate[] = [];
    const positionsFixed: Cartesian3[] = [];
    const positionsInertial: Cartesian3[] = [];
    for (let time = start; JulianDate.compare(stop, time) >= 0; time = JulianDate.addSeconds(time, samplingInterval, new JulianDate())) {
      const { positionFixed, positionInertial } = this.#computePosition(time, !!inertialProperty);
      times.push(time);
      positionsFixed.push(positionFixed);
      if (inertialProperty) positionsInertial.push(positionInertial);
    }
    // Add all samples at once as adding a sorted array avoids searching for the correct position every time
    this.#data.fixed.addSamples(times, positionsFixed);
    inertialProperty?.addSamples(times, positionsInertial);
  }

  #computePositionInertialTEME(time: JulianDate): Cartesian3 {
    const eci = this.#orbit.positionECI(JulianDate.toDate(time));
    if (this.#orbit.error || !eci) {
      if (this.#data) this.#data.valid = false;
      return Cartesian3.ZERO;
    }
    return new Cartesian3(eci.x * 1000, eci.y * 1000, eci.z * 1000);
  }

  /**
   * `withInertial` gates the ICRF half, and with it the requirement that ICRF
   * data be loaded at all. A scene drawing points and nothing else no longer
   * needs it, so it is no longer a reason to mark the trajectory invalid.
   */
  #computePosition(timestamp: JulianDate, withInertial: boolean): { positionFixed: Cartesian3; positionInertial: Cartesian3 } {
    const positionInertialTEME = this.#computePositionInertialTEME(timestamp);

    const temeToFixed = Transforms.computeTemeToPseudoFixedMatrix(timestamp);
    const fixedToIcrf = withInertial ? Transforms.computeFixedToIcrfMatrix(timestamp) : undefined;
    if (!defined(temeToFixed) || (withInertial && !defined(fixedToIcrf))) {
      // Reference frame data is not available for this time (outside the preloaded ICRF window or
      // before the async load resolves). Skip the sample instead of multiplying by an undefined
      // matrix, which throws a DeveloperError inside Cesium's render loop.
      console.error("Reference frame transformation data failed to load");
      if (this.#data) this.#data.valid = false;
      return { positionFixed: Cartesian3.ZERO, positionInertial: Cartesian3.ZERO };
    }

    const positionFixed = Matrix3.multiplyByVector(temeToFixed, positionInertialTEME, new Cartesian3());
    const positionInertialICRF = fixedToIcrf ? Matrix3.multiplyByVector(fixedToIcrf, positionFixed, new Cartesian3()) : Cartesian3.ZERO;

    return { positionFixed, positionInertial: positionInertialICRF };
  }
}

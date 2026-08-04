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
import { GridPositionProperty } from "./util/GridPositionProperty";
import type { SampleChunk, TrajectorySampler } from "./util/sampleSource";
import { trajectoryWindow } from "./util/trajectoryWindow";

// Cesium 1.143 widened the InterpolationAlgorithm interface (type/interpolate) without
// updating the LagrangePolynomialApproximation namespace declaration; the runtime object
// satisfies the interface, so bridge the upstream typings gap with a cast.
const lagrangeInterpolation = LagrangePolynomialApproximation as unknown as InterpolationAlgorithm;

interface SampledPositionData {
  interval: TimeInterval;
  /**
   * Absent until a path graphic asks for it, exactly like `inertial`. The grid is
   * what everything else reads, and a `SampledPositionProperty` over the same
   * window is expensive in a way that is easy to miss: a `JulianDate` object per
   * sample, and 241 of those per satellite. Measured at 13.2 KB a satellite — 66 MB
   * across five thousand. See `requireSampled`.
   */
  fixed: SampledPositionProperty | undefined;
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

  /** Whether any consumer has asked for the sampled property. See requireSampled. */
  #wantsSampled = false;

  /**
   * Where samples come from. Injected rather than reached for, so this class has
   * no opinion about whether propagation happens on a worker — see sampleSource.
   */
  readonly #sampler: TrajectorySampler;

  /**
   * The same fixed-frame samples again, on a uniform grid, for entities to read.
   *
   * Entities are evaluated once each per frame and that evaluation was the largest
   * single cost in a large scene — measured at 5,000 satellites, halving
   * `dataSourceDisplay.update` from 12.0 ms to 5.1 and taking the frame rate from
   * 71 to 97. See GridPositionProperty for why, and for the caveats.
   *
   * The authoritative store, and the only one most satellites have: `fixed` and
   * `inertial` are both built on demand from this. A flat array of doubles is also
   * far cheaper than a `SampledPositionProperty` over the same window — 25.7
   * against 38.7 KB a satellite for everything a satellite owns, some 74 MB less
   * at 5,000 — because it derives sample times from the anchor instead of keeping
   * a `JulianDate` object per sample.
   */
  #gridFixed = new GridPositionProperty();

  /**
   * False when a chunk arrived with samples the propagator refused. The grid read
   * depends on there being no holes in it, so such a satellite falls back to the
   * sampled property — correct, merely slower. Measured across the live catalog
   * this has never fired.
   */
  #gridUsable = true;

  /** The fill in flight, if any. At most one — see `ensure`. */
  #filling: Promise<void> | undefined;

  /** The time a coalesced tick asked about, to be honoured once the fill lands. */
  #pendingTime: JulianDate | undefined;

  constructor(orbit: Orbit, sampler: TrajectorySampler) {
    this.#orbit = orbit;
    this.#sampler = sampler;
  }

  /** Whether samples exist and propagation has not failed. */
  get valid(): boolean {
    return this.#data?.valid ?? false;
  }

  /**
   * Fixed-frame samples, irregular-capable. What path graphics need: Cesium's
   * PathVisualizer sub-samples a `SampledPositionProperty` at its stored sample
   * times and anything else at `resolution`, which would be far coarser.
   *
   * Call `requireSampled` first — like `inertial`, this returns undefined on a
   * trajectory nothing has asked for it on rather than quietly building one.
   */
  get fixed(): SampledPositionProperty | undefined {
    return this.#data?.fixed;
  }

  /**
   * Declare that the irregular-capable property is needed, and make it so.
   *
   * The same shape as `requireInertial`: a flag so every later refresh feeds it,
   * and a backfill from the grid so a window already up is not re-propagated. The
   * backfill is the grid's own samples with times derived from the anchor, so it
   * costs no SGP4 and no frame transforms.
   */
  requireSampled(): void {
    if (this.#wantsSampled) {
      return;
    }
    this.#wantsSampled = true;
    this.#backfillSampled();
  }

  #backfillSampled(): void {
    const data = this.#data;
    if (!data || data.fixed) {
      return;
    }
    const fixed = SampledTrajectory.#createProperty(ReferenceFrame.FIXED);
    const { times, positions } = this.#windowSamples();
    if (times.length > 0) {
      fixed.addSamples(times, positions);
    }
    data.fixed = fixed;
  }

  /**
   * The window's samples, from whichever store currently owns them.
   *
   * Normally the grid. Once a gap has made the grid unusable it is abandoned and
   * cleared, and the sampled property is the only complete record — reading the
   * grid then would hand back the window it happened to stop at, which is a
   * position for the wrong time rather than a missing one.
   */
  #windowSamples(): { times: JulianDate[]; positions: Cartesian3[] } {
    if (this.#gridUsable && this.#gridFixed.length > 0) {
      return this.#gridFixed.allSamples();
    }
    const fixed = this.#data?.fixed;
    if (!fixed) {
      return { times: [], positions: [] };
    }
    const { times, values } = fixed.getRawSamples();
    return { times, positions: values as Cartesian3[] };
  }

  /**
   * How many samples the window holds, whichever store owns them.
   *
   * Exists so a caller can ask about the window without first working out which
   * property is live — and because the two stores spell it differently (`length` a
   * getter here, `length()` a method on Cesium's).
   */
  get sampleCount(): number {
    if (this.#gridUsable && this.#gridFixed.length > 0) {
      return this.#gridFixed.length;
    }
    return this.#data?.fixed?.length() ?? 0;
  }

  /** Positions between two instants, from whichever store owns them. See `#windowSamples`. */
  #positionsBetween(start: JulianDate, end: JulianDate): Cartesian3[] {
    if (this.#gridUsable && this.#gridFixed.length > 0) {
      return this.#gridFixed.samplesBetween(start, end).positions;
    }
    const fixed = this.#data?.fixed;
    return fixed ? (fixed.getRawValues(start, end) as Cartesian3[]) : [];
  }

  /**
   * What an entity should bind its position to — the grid property where usable.
   *
   * Everything that only ever asks "where is it now" goes through here. Path
   * graphics deliberately do not; see `fixed`.
   */
  get entityPosition(): GridPositionProperty | SampledPositionProperty | undefined {
    if (!this.#data) {
      return undefined;
    }
    return this.#gridUsable && this.#gridFixed.length > 0 ? this.#gridFixed : this.#data.fixed;
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
    // From the grid, which always holds the window; the sampled property may not
    // exist at all, and when it does it holds the same samples anyway.
    const { times, positions: values } = this.#windowSamples();
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

  /**
   * Fixed-frame position at `time`, interpolated from the samples.
   *
   * Through `entityPosition`, because the callers are the same shape as an entity:
   * the sky HUD and the sensor cone's orientation both ask this once per frame.
   */
  position(time: JulianDate): Cartesian3 | undefined {
    return this.entityPosition?.getValue(time);
  }

  positionsForNextOrbit(start: JulianDate, reference: "inertial" | "fixed" = "inertial", loop = true): unknown[] {
    if (!this.#data) return [];
    const end = JulianDate.addSeconds(start, this.#orbit.orbitalPeriod * 60, new JulianDate());
    let positions: unknown[];
    if (reference === "fixed") {
      // The grid holds the same samples and always exists, so asking for the
      // Earth-relative path does not drag a sampled property into being.
      positions = this.#positionsBetween(start, end);
    } else {
      // The caller wants the inertial frame, which is the declaration itself.
      this.requireInertial();
      const inertial = this.#data.inertial;
      if (!inertial) return [];
      positions = inertial.getRawValues(start, end);
    }
    if (positions.length === 0) return [];
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
    const samples = this.#positionsBetween(start, end);
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
   * Take an opening window fetched before this trajectory existed.
   *
   * The build fetches it, because a satellite is only worth constructing once its
   * samples are in hand — and constructing it is `sgp4init`, which belongs inside
   * the build's frame budget rather than in a loop over the whole activation.
   *
   * The interval is the chunk's own extent rather than the policy window: the
   * first `ensure` computes that and tops up the difference.
   */
  adopt(chunk: SampleChunk): void {
    const sampleCount = Math.floor(chunk.teme.length / 3);
    if (this.#data || sampleCount === 0) {
      return;
    }
    const start = SampledTrajectory.#sampleTime(chunk, 0);
    const stop = SampledTrajectory.#sampleTime(chunk, sampleCount - 1);
    this.#init(start);
    this.#applyChunk(chunk);
    this.#setInterval(new TimeInterval({ start, stop }));
  }

  /**
   * Make sure the window covers `time`, requesting whatever is missing.
   *
   * The single way samples ever enter this class. Awaitable because the samples
   * come from somewhere else now: the build awaits the first call so a satellite
   * is only shown once it has a position, and the periodic top-up does not await
   * at all — the window runs one and a half revolutions ahead of the clock, so a
   * reply arriving a few frames late is invisible.
   *
   * The requested bounds are deliberately approximate. They come from this
   * satellite's own period, which differs slightly from the one the sampler
   * derives, and it does not matter: the sampler answers on a grid anchored to the
   * element set's epoch, so a window a few seconds wider or narrower changes which
   * samples come back but never where they sit in time.
   *
   * At most one request is outstanding at a time. Without that, a tick arriving
   * before the previous reply computed the same missing range and asked for it
   * again: measured at 5,000 satellites and ×10000, the sampler was producing
   * 2.5 million samples a second where the window needs about 1.1 million.
   */
  ensure(time: JulianDate): Promise<void> {
    if (this.#filling) {
      // A tick arrived while a request was already out. Neither queue it — at a
      // fast clock the ticks outrun the replies and the queue only grows — nor
      // drop it, which would lose a clock that jumped mid-request. Remember the
      // latest time and re-run once, when the current fill lands.
      this.#pendingTime = time;
      return this.#filling;
    }
    this.#filling = this.#fill(time).finally(() => {
      this.#filling = undefined;
      const pending = this.#pendingTime;
      this.#pendingTime = undefined;
      if (pending) {
        void this.ensure(pending);
      }
    });
    return this.#filling;
  }

  async #fill(time: JulianDate): Promise<void> {
    const window = trajectoryWindow(this.#orbit.orbitalPeriod);
    if (window.sampleCount === 0) {
      return;
    }
    const request = new TimeInterval({
      start: JulianDate.addSeconds(time, window.offsetSeconds, new JulianDate()),
      stop: JulianDate.addSeconds(time, window.offsetSeconds + window.spanSeconds, new JulianDate()),
    });

    // Nothing yet, or the clock has jumped clear of what is held: one request for
    // the whole window rather than two for its edges.
    if (!this.#data || !TimeInterval.contains(this.#data.interval, time)) {
      const chunk = await this.#sampler.samples(JulianDate.toDate(request.start).getTime(), JulianDate.toDate(request.stop).getTime());
      if (!chunk || chunk.teme.length === 0) {
        return;
      }
      this.#init(request.start);
      this.#applyChunk(chunk);
      this.#setInterval(request);
      return;
    }

    const held = this.#data.interval;
    const missingBefore = JulianDate.secondsDifference(held.start, request.start) > 0;
    const missingAfter = JulianDate.secondsDifference(request.stop, held.stop) > 0;
    const chunks = await Promise.all([
      missingBefore ? this.#sampler.samples(JulianDate.toDate(request.start).getTime(), JulianDate.toDate(held.start).getTime()) : undefined,
      missingAfter ? this.#sampler.samples(JulianDate.toDate(held.stop).getTime(), JulianDate.toDate(request.stop).getTime()) : undefined,
    ]);
    // Torn down while the request was in flight.
    if (!this.#data) {
      return;
    }
    for (const chunk of chunks) {
      if (chunk) this.#applyChunk(chunk);
    }
    this.#evict(request);
    this.#data.interval = request;
  }

  /**
   * Turn one chunk of TEME samples into sampled positions.
   *
   * The frame transforms happen here rather than in the sampler: they are Cesium's,
   * they need IAU data a worker has no business loading a second copy of, and they
   * were measured at 43% of this work against 57% for the propagation that did
   * move. Refused samples are skipped, not re-propagated — retrying would run the
   * same propagator on the same instant and fail the same way, and a sampled
   * position property interpolates across the gap.
   */
  #applyChunk(chunk: SampleChunk): void {
    const data = this.#data;
    if (!data) {
      return;
    }
    const sampleCount = Math.floor(chunk.teme.length / 3);
    const refused = chunk.refusedIndices.length > 0 ? new Set(chunk.refusedIndices) : undefined;
    const inertialProperty = data.inertial;
    const times: JulianDate[] = [];
    const positionsFixed: Cartesian3[] = [];
    const positionsInertial: Cartesian3[] = [];
    const anchor = SampledTrajectory.#chunkAnchor(chunk);
    // One scratch for the TEME position: it is read by the transform and never
    // kept, so allocating a Cartesian3 per sample was 1.2 million objects that
    // existed to be thrown away.
    const teme = new Cartesian3();

    for (let index = 0; index < sampleCount; index += 1) {
      if (refused?.has(index)) {
        continue;
      }
      const offset = index * 3;
      teme.x = chunk.teme[offset] as number;
      teme.y = chunk.teme[offset + 1] as number;
      teme.z = chunk.teme[offset + 2] as number;
      const time = SampledTrajectory.#sampleTimeFrom(anchor, chunk, index);
      const framed = this.#toFrames(time, teme, !!inertialProperty);
      if (!framed) {
        continue;
      }
      times.push(time);
      positionsFixed.push(framed.positionFixed);
      if (inertialProperty) positionsInertial.push(framed.positionInertial);
    }

    if (times.length === 0) {
      return;
    }
    // The grid first, and only then the sampled property: a gap here forces the
    // sampled property into being, and its backfill reads the grid as it was
    // before this chunk. Any shortfall counts as a gap, not just a refusal — a
    // missing frame transform drops a sample the same way, and the grid's indices
    // only line up with the chunk's when nothing was dropped.
    this.#addToGrid(chunk, positionsFixed, positionsFixed.length !== sampleCount);
    // Added at once: a sorted array avoids a search per sample.
    this.#data?.fixed?.addSamples(times, positionsFixed);
    inertialProperty?.addSamples(times, positionsInertial);
  }

  /**
   * Mirror a chunk into the grid property.
   *
   * A gap makes the grid unusable rather than approximated: the grid read assumes
   * no holes, and closing one by interpolating across a 45 s gap would put the
   * satellite kilometres out at that instant. Such a satellite reads from the
   * sampled property instead, which is slower and correct — and unusable is
   * permanent, because the samples that would have filled the hole are not coming.
   * The next refresh rebinds the entities (see updatedSampledPositionForComponents).
   */
  #addToGrid(chunk: SampleChunk, positionsFixed: Cartesian3[], hadGaps: boolean): void {
    if (!this.#gridUsable) {
      return;
    }
    if (hadGaps) {
      // Order is the whole of it. The grid is still the authoritative record at
      // this instant and the backfill reads whichever store is authoritative, so
      // asking for the sampled property has to happen *before* the grid is
      // disowned — flipping the flag first made `#windowSamples` skip the grid,
      // find a `fixed` that did not exist yet, and hand back nothing, leaving the
      // new property holding only this chunk. Then let the buffer go: an abandoned
      // grid that keeps its samples is a window frozen where it was abandoned.
      this.requireSampled();
      this.#gridUsable = false;
      this.#gridFixed.clear();
      return;
    }
    if (!this.#gridFixed.isOnGrid(chunk.anchorEpochMs, chunk.stepSeconds)) {
      this.#gridFixed.reset(chunk.anchorEpochMs, chunk.stepSeconds);
    }
    const flat = new Float64Array(positionsFixed.length * 3);
    for (const [index, position] of positionsFixed.entries()) {
      flat[index * 3] = position.x;
      flat[index * 3 + 1] = position.y;
      flat[index * 3 + 2] = position.z;
    }
    if (!this.#gridFixed.add(chunk.firstIndex, flat)) {
      // Not contiguous with what is held — a clock jump landing between windows.
      // Start the grid again from this chunk rather than leave a hole in it.
      this.#gridFixed.reset(chunk.anchorEpochMs, chunk.stepSeconds);
      this.#gridFixed.add(chunk.firstIndex, flat);
    }
  }

  /** Its own method so the caller's narrowing of `#data` does not reach in here. */
  #setInterval(interval: TimeInterval): void {
    if (this.#data) {
      this.#data.interval = interval;
    }
  }

  /**
   * The chunk's grid origin as a JulianDate.
   *
   * Hoisted out of the per-sample path deliberately. It is one value for the whole
   * chunk, and rebuilding it per sample meant a `Date` and a `JulianDate` allocated
   * for each of 241 samples per satellite — 1.2 million of each across a
   * 5,000-satellite build, which was the largest single slice of the window
   * handling.
   */
  static #chunkAnchor(chunk: SampleChunk): JulianDate {
    return JulianDate.fromDate(new Date(chunk.anchorEpochMs));
  }

  /**
   * The instant of one sample, from the grid rather than from the chunk's start.
   *
   * Every chunk for a satellite carries the same anchor, so the same grid index
   * always yields the same JulianDate — which is what stops two chunks from
   * placing one grid instant at two times a fraction of a millisecond apart. See
   * Sgp4Chunk.anchorEpochMs.
   */
  static #sampleTimeFrom(anchor: JulianDate, chunk: SampleChunk, index: number): JulianDate {
    return JulianDate.addSeconds(anchor, (chunk.firstIndex + index) * chunk.stepSeconds, new JulianDate());
  }

  /** The same instant, for the two callers that want one sample and not a run of them. */
  static #sampleTime(chunk: SampleChunk, index: number): JulianDate {
    return SampledTrajectory.#sampleTimeFrom(SampledTrajectory.#chunkAnchor(chunk), chunk, index);
  }

  #evict(keep: TimeInterval): void {
    const data = this.#data;
    if (!data) {
      return;
    }
    const before = new TimeInterval({ start: JulianDate.fromIso8601("1957"), stop: keep.start, isStartIncluded: false, isStopIncluded: false });
    const after = new TimeInterval({ start: keep.stop, stop: JulianDate.fromIso8601("2100"), isStartIncluded: false, isStopIncluded: false });
    data.fixed?.removeSamples(before);
    data.fixed?.removeSamples(after);
    data.inertial?.removeSamples(before);
    data.inertial?.removeSamples(after);
    if (this.#gridFixed.length > 0) {
      this.#gridFixed.dropBefore(this.#gridFixed.indexAtOrAfter(keep.start));
      this.#gridFixed.dropAfter(this.#gridFixed.indexAtOrAfter(keep.stop));
    }
  }

  /**
   * Keep the window fresh, and hand back the teardown.
   *
   * The opening window is not filled here — the build awaits `ensure` before the
   * satellite is shown, so by the time this runs there is one. All this does is
   * arrange for the top-ups.
   */
  start(viewer: Viewer, callback: () => void): () => void {
    callback();
    const samplingRefreshRate = (this.#orbit.orbitalPeriod * 60) / 4;
    const removeCallback = CesiumCallbackHelper.createPeriodicTimeCallback(viewer, samplingRefreshRate, (time) => {
      void this.ensure(time).then(() => {
        // Torn down while the top-up was in flight.
        if (this.#data) callback();
      });
    });
    return () => {
      removeCallback();
      this.#data = undefined;
      // So a fill still in flight does not schedule another one after teardown.
      this.#pendingTime = undefined;
    };
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
    this.#gridUsable = true;
    this.#data = {
      interval: new TimeInterval({
        start: currentTime,
        stop: currentTime,
        isStartIncluded: false,
        isStopIncluded: false,
      }),
      // Both only if something has already asked. A re-init mid-life keeps
      // whatever the trajectory was already committed to sampling.
      fixed: this.#wantsSampled ? SampledTrajectory.#createProperty() : undefined,
      inertial: this.#wantsInertial ? SampledTrajectory.#createProperty(ReferenceFrame.INERTIAL) : undefined,
      valid: true,
    };
  }

  /**
   * TEME into the frames the scene draws in.
   *
   * Undefined when the transform data is not there, which drops the sample rather
   * than storing a wrong one — multiplying by an undefined matrix throws a
   * DeveloperError from inside Cesium's render loop. `withInertial` gates the ICRF
   * half and with it the need for ICRF data at all: a scene drawing points and
   * nothing else does not need it, so its absence is no longer a reason to
   * invalidate a trajectory.
   */
  #toFrames(timestamp: JulianDate, positionInertialTEME: Cartesian3, withInertial: boolean): { positionFixed: Cartesian3; positionInertial: Cartesian3 } | undefined {
    const temeToFixed = Transforms.computeTemeToPseudoFixedMatrix(timestamp);
    const fixedToIcrf = withInertial ? Transforms.computeFixedToIcrfMatrix(timestamp) : undefined;
    if (!defined(temeToFixed) || (withInertial && !defined(fixedToIcrf))) {
      // Reported once per trajectory rather than once per sample: a window is a
      // couple of hundred of these and the cause is the same for all of them.
      if (this.#data?.valid) {
        console.error("Reference frame transformation data failed to load");
        this.#data.valid = false;
      }
      return undefined;
    }

    const positionFixed = Matrix3.multiplyByVector(temeToFixed, positionInertialTEME, new Cartesian3());
    const positionInertialICRF = fixedToIcrf ? Matrix3.multiplyByVector(fixedToIcrf, positionFixed, new Cartesian3()) : Cartesian3.ZERO;

    return { positionFixed, positionInertial: positionInertialICRF };
  }
}

// A position property that interpolates over a uniform grid held in a flat
// typed array.
//
// It exists because evaluating a position is the single largest per-frame cost in
// a large scene, and almost none of that cost is the interpolation itself.
// Cesium's `SampledPositionProperty` supports irregular sample times, so every
// read does a bracket search, JulianDate arithmetic, a copy into interpolation
// scratch tables and a Cartesian3 allocation. Our samples are not irregular —
// they sit on a grid anchored to the element set's epoch (see sgp4Worker) — so
// finding the bracket is one `Math.floor` and the rest is arithmetic on a
// Float64Array.
//
// Measured at 5,000 satellites drawing points, swapping only `entity.position` on
// one live scene and putting it back again — an A/B/A, because a whole benchmark
// sweep could not resolve this: its own drift check fired at ±23-49% on `cpuMs`,
// and build times for identical work varied by 3x between runs.
//
//                                this   Cesium   this again
//     dataSourceDisplay.update   6.10     12.02   5.03 ms
//     fps                        99.9      71.1   96.8
//
// Across separate matched sweeps the propagation-and-update half of the frame,
// `tickMs` at 5,000, went 11.08 -> 4.91 ms; that one is worth quoting because it
// reproduced (11.08/11.44/9.31 before, 4.91/4.63 after) far outside the noise the
// other columns carry.
//
// It also *saves* memory, which was not the point but is the larger effect: 25.7
// against 38.7 KB a satellite for everything a satellite owns, some 74 MB less at
// 5,000. A `SampledPositionProperty` keeps a `JulianDate` object per sample and
// there are 241 of them per satellite; deriving the times from the anchor instead
// means the samples are three doubles each and nothing else. See SampledTrajectory,
// which now builds the irregular-capable properties on demand from this one.
//
// Accuracy is checked against an independent SGP4 — python-sgp4, Vallado's
// reference implementation — given the same element sets and the same instants,
// comparing the two quantities a rotation about the Earth's axis leaves alone
// (radius and the axial component), so no frame code of the checker's own enters
// the comparison. Worst case over the regimes in the catalog, against what Cesium's
// own degree-5 interpolation produces from the same samples:
//
//     Starlink       94 min        4.7 m   (Cesium: 4.3 m)
//     Meteosat     1436 min        0.1 m   (Cesium: 0.0 m)
//     MMS 1        5114 min       37.9 m   (Cesium: 38.5 m)
//
// The stencil is six for that last row and no other reason; see STENCIL, which
// also says why re-checking this has to reach past the head of the catalog.
//
// Note what this is *not* an optimisation of. Lowering Cesium's
// `interpolationDegree` from 5 to 1 saves 0.88 ms of 12 (7%) and costs 2.5 km of
// accuracy; degree 3 costs 1 m and saves 0.4 ms. The degree was never the
// problem, which is why this replaces the machinery rather than tuning it.

import { Cartesian3, Event, JulianDate, PositionProperty, ReferenceFrame } from "@cesium/engine";

/**
 * `PositionProperty.convertToReferenceFrame` is a real static on the runtime class
 * but is missing from the published typings, so it is reached through a cast in
 * one place rather than with an `any` at the call site.
 */
const convertToReferenceFrame = (
  PositionProperty as unknown as {
    convertToReferenceFrame(time: JulianDate, value: Cartesian3, inputFrame: ReferenceFrame, outputFrame: ReferenceFrame, result: Cartesian3): Cartesian3 | undefined;
  }
).convertToReferenceFrame;

/**
 * Samples the interpolation reads. Six gives a quintic, matching the degree Cesium's
 * `SampledPositionProperty` was configured with.
 *
 * Four — a cubic — was enough for every orbit anyone had looked at, and wrong for
 * the ones nobody had. Truncation error goes as `h^(n+1)`, so dropping from degree 5
 * to 3 costs a factor of `h^2`, and `h` here is a fixed fraction of the *period*:
 * 120 samples an orbit is 45 s for the ISS and 43 minutes for a magnetospheric
 * orbit. Checked against the reference SGP4 on MMS 1 (period 3.5 days, highly
 * eccentric), a cubic was 3.7 km out where the quintic is 13 m — the error is almost
 * entirely radial, which is what a low-order fit through a fast-changing radius
 * looks like. LEO was unaffected either way, which is why sampling only Starlink
 * missed it.
 */
const STENCIL = 6;

/** Spare capacity a grow leaves behind. See `#ensure`. */
const GROWTH_HEADROOM = 1.25;

/**
 * Positions on a uniform time grid, readable as a Cesium position property.
 *
 * The grid is defined by an anchor and a step, and a sample's index is its
 * position on that grid — so two batches of samples computed at different times
 * describe the same instants as long as they agree on the anchor, which is what
 * makes appending safe without any matching of times.
 */
export class GridPositionProperty {
  readonly #frame: ReferenceFrame;

  /**
   * Underscore-prefixed, and public, because Cesium reads it that way.
   *
   * `VelocityVectorProperty`'s position setter subscribes via
   * `value._definitionChanged.addEventListener` rather than through the
   * `definitionChanged` getter its own interface documents, so a property that
   * only has the getter throws the moment an entity is given a
   * `VelocityOrientationProperty` over it. Every Cesium property happens to keep
   * the event in a field of this name, which is why nothing upstream notices.
   */
  readonly _definitionChanged = new Event();

  #anchorEpochMs = 0;

  #stepSeconds = 0;

  /** Grid index of the first sample held. */
  #firstIndex = 0;

  #count = 0;

  /** x, y, z per sample, in `#frame`. Grown as needed, never shrunk. */
  #positions = new Float64Array(0);

  /** The anchor as a JulianDate, made once: every read would otherwise rebuild it. */
  #anchor = new JulianDate();

  constructor(referenceFrame: ReferenceFrame = ReferenceFrame.FIXED) {
    this.#frame = referenceFrame;
  }

  get referenceFrame(): ReferenceFrame {
    return this.#frame;
  }

  get isConstant(): boolean {
    return this.#count === 0;
  }

  get definitionChanged(): Event {
    return this._definitionChanged;
  }

  get length(): number {
    return this.#count;
  }

  get stepSeconds(): number {
    return this.#stepSeconds;
  }

  /** Grid index of the first and last samples held, for the caller's own bookkeeping. */
  get firstIndex(): number {
    return this.#firstIndex;
  }

  /** The instant of a grid index. Derived from the anchor, never from a stored time. */
  timeAt(gridIndex: number, result?: JulianDate): JulianDate {
    return JulianDate.addSeconds(this.#anchor, gridIndex * this.#stepSeconds, result ?? new JulianDate());
  }

  /**
   * Adopt a grid. Discards anything held, because a different anchor or step means
   * the indices no longer mean the same instants.
   */
  reset(anchorEpochMs: number, stepSeconds: number): void {
    this.#anchorEpochMs = anchorEpochMs;
    this.#stepSeconds = stepSeconds;
    this.#anchor = JulianDate.fromDate(new Date(anchorEpochMs));
    this.#firstIndex = 0;
    this.#count = 0;
    this._definitionChanged.raiseEvent(this);
  }

  /** Drop everything and release the buffer, for a grid that is being abandoned. */
  clear(): void {
    this.#firstIndex = 0;
    this.#count = 0;
    this.#stepSeconds = 0;
    this.#positions = new Float64Array(0);
    this._definitionChanged.raiseEvent(this);
  }

  isOnGrid(anchorEpochMs: number, stepSeconds: number): boolean {
    return this.#count > 0 && this.#anchorEpochMs === anchorEpochMs && this.#stepSeconds === stepSeconds;
  }

  /**
   * Add samples starting at `gridIndex`.
   *
   * Contiguity is the one requirement, and it is checked rather than assumed: a
   * uniform grid is the whole basis of the fast read, so a batch that would leave
   * a hole is rejected instead of silently shifting every sample after it. The
   * caller — which knows what it asked for — treats that as a failed fill.
   */
  add(gridIndex: number, xyz: Float64Array): boolean {
    const incoming = Math.floor(xyz.length / 3);
    if (incoming === 0) {
      return true;
    }
    if (this.#count === 0) {
      this.#firstIndex = gridIndex;
      this.#ensure(incoming);
      this.#positions.set(xyz.subarray(0, incoming * 3), 0);
      this.#count = incoming;
      this._definitionChanged.raiseEvent(this);
      return true;
    }
    const end = this.#firstIndex + this.#count;
    if (gridIndex > end || gridIndex + incoming < this.#firstIndex) {
      // Disjoint from what is held; nothing sensible to splice.
      return false;
    }
    if (gridIndex >= this.#firstIndex && gridIndex + incoming <= end) {
      // Wholly inside: an overlap, which is legitimate — the caller may re-ask for
      // an interval it already has. Overwrite in place.
      this.#positions.set(xyz.subarray(0, incoming * 3), (gridIndex - this.#firstIndex) * 3);
      return true;
    }
    if (gridIndex < this.#firstIndex) {
      // Extends the front. Shift what is held up rather than reallocate, then write
      // the batch whole — where it overlaps, it overwrites with the same values,
      // which is cheaper than working out where the overlap starts.
      const prepend = this.#firstIndex - gridIndex;
      const total = Math.max(end, gridIndex + incoming) - gridIndex;
      this.#ensure(total);
      this.#positions.copyWithin(prepend * 3, 0, this.#count * 3);
      this.#positions.set(xyz.subarray(0, incoming * 3), 0);
      this.#firstIndex = gridIndex;
      this.#count = total;
      this._definitionChanged.raiseEvent(this);
      return true;
    }
    const total = gridIndex - this.#firstIndex + incoming;
    this.#ensure(total);
    this.#positions.set(xyz.subarray(0, incoming * 3), (gridIndex - this.#firstIndex) * 3);
    this.#count = total;
    this._definitionChanged.raiseEvent(this);
    return true;
  }

  /** How the window slides. */
  dropBefore(gridIndex: number): void {
    const drop = gridIndex - this.#firstIndex;
    if (drop <= 0 || this.#count === 0) {
      return;
    }
    if (drop >= this.#count) {
      this.#firstIndex = gridIndex;
      this.#count = 0;
      return;
    }
    this.#positions.copyWithin(0, drop * 3, this.#count * 3);
    this.#firstIndex = gridIndex;
    this.#count -= drop;
  }

  dropAfter(gridIndex: number): void {
    const keep = gridIndex - this.#firstIndex + 1;
    if (keep < 0) {
      this.#count = 0;
      return;
    }
    if (keep < this.#count) {
      this.#count = keep;
    }
  }

  #ensure(samples: number): void {
    if (this.#positions.length >= samples * 3) {
      return;
    }
    // Headroom, so a window that slides for hours stops reallocating after the
    // first top-up: a refresh appends before the eviction that makes room for it,
    // so the peak is a window plus one refresh's worth and the buffer settles
    // there. Not doubling — that would settle at twice a window and the whole
    // point of the flat array is that it is small.
    const grown = new Float64Array(Math.max(Math.ceil(samples * GROWTH_HEADROOM), STENCIL) * 3);
    grown.set(this.#positions.subarray(0, this.#count * 3));
    this.#positions = grown;
  }

  /**
   * A six-point quintic through the samples bracketing `time`.
   *
   * Outside the window it holds the end sample rather than extrapolating, matching
   * the HOLD the sampled property is configured with. That matters for one case:
   * the clock scrubbed clear of the window, where for the frame or two before the
   * refill lands a free-running polynomial half an orbit past its last node does not
   * return a slightly stale position but a meaningless one.
   */
  #interpolate(time: JulianDate, result: Cartesian3): Cartesian3 | undefined {
    if (this.#count === 0 || this.#stepSeconds <= 0) {
      return undefined;
    }
    if (this.#count < STENCIL) {
      // Too few to fit the stencil through: hold the nearest.
      const nearest = Math.min(this.#count - 1, Math.max(0, Math.round(JulianDate.secondsDifference(time, this.#anchor) / this.#stepSeconds) - this.#firstIndex));
      const at = nearest * 3;
      return Cartesian3.fromElements(this.#positions[at] as number, this.#positions[at + 1] as number, this.#positions[at + 2] as number, result);
    }
    const gridPosition = JulianDate.secondsDifference(time, this.#anchor) / this.#stepSeconds - this.#firstIndex;
    // Centred: two nodes behind the interval for a stencil of six, so the requested
    // instant sits between nodes 2 and 3 wherever the window allows it.
    let base = Math.floor(gridPosition) - 2;
    if (base < 0) {
      base = 0;
    }
    if (base > this.#count - STENCIL) {
      base = this.#count - STENCIL;
    }
    // Clamped to the stencil's own span, which is what makes the ends HOLD: at
    // u = 0 the basis is (1,0,0,0) and at u = 3 it is (0,0,0,1), so reading outside
    // the window returns the edge sample exactly.
    let u = gridPosition - base;
    if (u < 0) {
      u = 0;
    }
    if (u > STENCIL - 1) {
      u = STENCIL - 1;
    }
    // Lagrange basis for nodes 0..5 at u, expanded rather than looped. The
    // denominators are the products of node separations and so are constants.
    const d0 = u;
    const d1 = u - 1;
    const d2 = u - 2;
    const d3 = u - 3;
    const d4 = u - 4;
    const d5 = u - 5;
    const b0 = -(d1 * d2 * d3 * d4 * d5) / 120;
    const b1 = (d0 * d2 * d3 * d4 * d5) / 24;
    const b2 = -(d0 * d1 * d3 * d4 * d5) / 12;
    const b3 = (d0 * d1 * d2 * d4 * d5) / 12;
    const b4 = -(d0 * d1 * d2 * d3 * d5) / 24;
    const b5 = (d0 * d1 * d2 * d3 * d4) / 120;
    const p = base * 3;
    const a = this.#positions;
    result.x = (a[p] as number) * b0 + (a[p + 3] as number) * b1 + (a[p + 6] as number) * b2 + (a[p + 9] as number) * b3 + (a[p + 12] as number) * b4 + (a[p + 15] as number) * b5;
    result.y =
      (a[p + 1] as number) * b0 + (a[p + 4] as number) * b1 + (a[p + 7] as number) * b2 + (a[p + 10] as number) * b3 + (a[p + 13] as number) * b4 + (a[p + 16] as number) * b5;
    result.z =
      (a[p + 2] as number) * b0 + (a[p + 5] as number) * b1 + (a[p + 8] as number) * b2 + (a[p + 11] as number) * b3 + (a[p + 14] as number) * b4 + (a[p + 17] as number) * b5;
    return result;
  }

  getValue(time: JulianDate, result?: Cartesian3): Cartesian3 | undefined {
    return this.getValueInReferenceFrame(time, ReferenceFrame.FIXED, result);
  }

  getValueInReferenceFrame(time: JulianDate, referenceFrame: ReferenceFrame, result?: Cartesian3): Cartesian3 | undefined {
    const target = result ?? new Cartesian3();
    if (!this.#interpolate(time, target)) {
      return undefined;
    }
    if (referenceFrame === this.#frame) {
      return target;
    }
    return convertToReferenceFrame(time, target, this.#frame, referenceFrame, target);
  }

  /** For the callers that draw a line through the samples rather than reading one. */
  rawPositions(fromGridIndex = this.#firstIndex, toGridIndex = this.#firstIndex + this.#count - 1): Cartesian3[] {
    const from = Math.max(fromGridIndex, this.#firstIndex);
    const to = Math.min(toGridIndex, this.#firstIndex + this.#count - 1);
    const out: Cartesian3[] = [];
    for (let index = from; index <= to; index += 1) {
      const at = (index - this.#firstIndex) * 3;
      out.push(new Cartesian3(this.#positions[at] as number, this.#positions[at + 1] as number, this.#positions[at + 2] as number));
    }
    return out;
  }

  /** The grid index at or after `time`, for turning an instant into a range. */
  indexAtOrAfter(time: JulianDate): number {
    return Math.ceil(JulianDate.secondsDifference(time, this.#anchor) / this.#stepSeconds);
  }

  /**
   * Every sample held between two instants, with the times they sit at.
   *
   * The times are derived from the anchor rather than stored, which is the point:
   * a caller that needs `(time, position)` pairs — drawing a track, transforming a
   * window into another frame — can have them without this keeping a JulianDate
   * per sample, and a JulianDate per sample is most of what a
   * `SampledPositionProperty` costs.
   */
  samplesBetween(from: JulianDate, to: JulianDate): { times: JulianDate[]; positions: Cartesian3[] } {
    const times: JulianDate[] = [];
    const positions: Cartesian3[] = [];
    if (this.#count === 0 || this.#stepSeconds <= 0) {
      return { times, positions };
    }
    const first = Math.max(this.indexAtOrAfter(from), this.#firstIndex);
    const last = Math.min(Math.floor(JulianDate.secondsDifference(to, this.#anchor) / this.#stepSeconds), this.#firstIndex + this.#count - 1);
    for (let index = first; index <= last; index += 1) {
      const at = (index - this.#firstIndex) * 3;
      times.push(this.timeAt(index));
      positions.push(new Cartesian3(this.#positions[at] as number, this.#positions[at + 1] as number, this.#positions[at + 2] as number));
    }
    return { times, positions };
  }

  allSamples(): { times: JulianDate[]; positions: Cartesian3[] } {
    return this.samplesBetween(this.timeAt(this.#firstIndex), this.timeAt(this.#firstIndex + Math.max(0, this.#count - 1)));
  }

  equals(other?: GridPositionProperty): boolean {
    return this === other;
  }
}

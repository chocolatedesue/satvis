// Editing a list of ground stations.
//
// Pure and separate from the panel that calls it, because the panel is a Vue
// component and the suite runs in node with no DOM — while these are the rules
// worth pinning down. Two of them carry real weight: a latitude that is not a
// latitude must never reach the store, and the order decides which station the
// sky view stands at (docs/adr/0003-sky-view.md).
//
// Every function returns a fresh list of fresh stations. The store compares what
// it is given against what it holds, so editing in place would be invisible to
// it — and `setGroundStations` is the one writer, which is what these feed.

import type { SerializedGroundStation } from "../../stores/sat";

export const MAX_LATITUDE = 90;
export const MAX_LONGITUDE = 180;

/**
 * A coordinate read out of an input, or undefined when the text is not one.
 *
 * Undefined covers two cases that look different to a person and identical to a
 * caller: half-typed — `-`, `48.`, `` — and not a place at all — `500`, `banana`.
 * Both have to be refused rather than committed, because the store drops what it
 * cannot use, and a store that drops a station makes its row vanish while
 * somebody is still typing in it.
 *
 * `Number` rather than `parseFloat`, which reads `48abc` as 48 and would turn a
 * typo into a silent relocation.
 */
export function parseCoordinate(text: string, limit: number): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    return undefined;
  }
  return value;
}

/**
 * Where a row being dragged would land, from how far it has travelled.
 *
 * Rounded rather than floored, so a row swaps once it has passed the halfway
 * point of its neighbour rather than once it has cleared it entirely — which is
 * where the eye expects the list to part.
 */
export function dropIndex(from: number, deltaY: number, rowHeight: number, count: number): number {
  if (rowHeight <= 0) {
    return from;
  }
  // Rounded away from zero rather than by `Math.round`, which breaks ties toward
  // +∞: at exactly half a row `round(1.5)` is 2 and `round(-1.5)` is -1, so a
  // drag up would not mirror the same drag down.
  const rows = deltaY / rowHeight;
  const target = from + Math.sign(rows) * Math.round(Math.abs(rows));
  return Math.min(Math.max(target, 0), count - 1);
}

/**
 * How far a row that is *not* being dragged has to move to leave a gap where the
 * dragged one will land, in pixels.
 *
 * Everything between the row's old place and its new one shifts by exactly one
 * row, in the opposite direction to the drag. The dragged row itself is excluded:
 * it follows the pointer, not the list.
 */
export function dragShift(index: number, from: number, to: number, rowHeight: number): number {
  if (index === from) {
    return 0;
  }
  if (from < to && index > from && index <= to) {
    return -rowHeight;
  }
  if (from > to && index >= to && index < from) {
    return rowHeight;
  }
  return 0;
}

/**
 * The list again, as fresh objects. Everything below builds on this: the store
 * compares what it is given against what it holds, so a list edited in place is
 * a list it cannot see has changed.
 */
function copies(stations: readonly SerializedGroundStation[]): SerializedGroundStation[] {
  const next: SerializedGroundStation[] = [];
  for (const station of stations) {
    next.push({ ...station });
  }
  return next;
}

/** The list with one station moved by `by`, or unchanged if that leaves the list. */
export function moved(stations: readonly SerializedGroundStation[], index: number, by: number): SerializedGroundStation[] {
  const next = copies(stations);
  const to = index + by;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) {
    return next;
  }
  const [station] = next.splice(index, 1);
  if (station) {
    next.splice(to, 0, station);
  }
  return next;
}

export function without(stations: readonly SerializedGroundStation[], index: number): SerializedGroundStation[] {
  const next = copies(stations);
  if (index < 0 || index >= next.length) {
    return next;
  }
  next.splice(index, 1);
  return next;
}

/**
 * Where the observer designation lands after `moved(stations, index, by)`.
 *
 * The designation names a station, not a rank, so reordering the list must not
 * hand it to somebody else. Three cases: the observer is the station being
 * dragged and travels with it; the observer is the station the drag displaces and
 * shifts one step out of the way; or the drag happens entirely past the observer
 * and nothing changes.
 *
 * `count` is the list length, so a drag that would leave the list is refused here
 * exactly as `moved` refuses it.
 */
export function observerAfterMove(observer: number, index: number, by: number, count: number): number {
  const to = index + by;
  if (index < 0 || index >= count || to < 0 || to >= count) {
    return observer;
  }
  if (observer === index) {
    return to;
  }
  // Removing `index` shifts everything after it down; inserting at `to` shifts
  // everything from there up. Only a station between the two feels both.
  if (index < observer && observer <= to) {
    return observer - 1;
  }
  if (to <= observer && observer < index) {
    return observer + 1;
  }
  return observer;
}

/**
 * Where the observer designation lands after `without(stations, index)`.
 *
 * Removing the observer itself hands the designation to the first station. That is
 * the old default, and the only choice that needs no guess about which survivor was
 * meant. Removing anybody ahead of it just closes the gap.
 */
export function observerAfterRemoval(observer: number, index: number, count: number): number {
  if (index < 0 || index >= count) {
    return observer;
  }
  if (observer === index) {
    return 0;
  }
  return index < observer ? observer - 1 : observer;
}

/**
 * The list with one station renamed. An empty name removes the name rather than
 * storing one: a station with no name is identified by its coordinates, and `""`
 * would travel through the url as a trailing separator that means the same thing
 * less clearly.
 */
export function renamed(stations: readonly SerializedGroundStation[], index: number, name: string): SerializedGroundStation[] {
  const next = copies(stations);
  const station = next[index];
  if (!station) {
    return next;
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    delete station.name;
  } else {
    station.name = trimmed;
  }
  return next;
}

/** The list with one station's latitude or longitude replaced. */
export function relocated(stations: readonly SerializedGroundStation[], index: number, field: "lat" | "lon", value: number): SerializedGroundStation[] {
  const next = copies(stations);
  const station = next[index];
  if (station) {
    station[field] = value;
  }
  return next;
}

/**
 * The list with one station moved to a new position, keeping its name and its
 * place in the list.
 *
 * Both coordinates at once, unlike `relocated`. A walk in the sky view arrives as
 * a position, not as two independent edits. Applying it in two steps would put a
 * station somewhere neither the old nor the new place for one tick.
 */
export function repositioned(stations: readonly SerializedGroundStation[], index: number, lat: number, lon: number): SerializedGroundStation[] {
  const next = copies(stations);
  const station = next[index];
  if (station) {
    station.lat = lat;
    station.lon = lon;
  }
  return next;
}

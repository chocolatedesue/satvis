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

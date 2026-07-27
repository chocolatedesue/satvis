// One answer to "did this actually change?".
//
// Several places need it for the same reason: a write is not free. Assigning an
// equal value to a store ref still fires the url sync and lands a history
// entry, and handing the manager an equal scene still tears components down and
// rebuilds them. Decoded values arrive as fresh arrays and objects every time,
// so identity alone never says no.

interface Comparable {
  [key: string]: unknown;
}

/**
 * Structural comparison, short-circuiting on identity. Deliberately not
 * JSON-based: `enabledSatellites` can hold thousands of names with Starlink
 * enabled, and serialising that on every toggle to avoid a write is the wrong
 * trade. This walks and stops at the first difference, allocating nothing for
 * the common case of two lists of strings.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  // Checked before the object branch: an array and a plain object are both
  // typeof "object", and an empty one of each has zero keys.
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, index) => sameValue(entry, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameValue((a as Comparable)[key], (b as Comparable)[key]));
}

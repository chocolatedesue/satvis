// Pure target-set computation for lazy satellite instantiation.
//
// Given the catalog entries and the current activation state (enabled tags,
// enabled satellite names, tracked/pending-tracked names), compute the set of
// catalog entry keys that should have a live SatelliteComponentCollection.
//
// A satellite is a target if ANY of the following holds (OR semantics):
//   - one of its tags is in `enabledTags` AND its name is not in
//     `disabledSatellites` (per-member opt-out within an enabled group)
//   - its name is in `enabledSatellites`
//   - its name equals the currently tracked satellite name
//   - its name equals the pending-tracked satellite name
//
// `disabledSatellites` only beats tag-activation: an explicit individual
// enable or tracking still wins (the browser UI keeps a name out of both
// lists at once, so that state only arises from hand-edited URLs).
//
// Tracking alone keeps a satellite alive even when its tag is disabled — this
// is an intentional improvement over the previous behavior, which left a
// dangling trackedEntity when a tracked satellite's tag was toggled off.
//
// This module must stay Cesium-free (it operates on plain CatalogEntry values)
// so it can be unit-tested in the node-env vitest without loading Cesium.

import type { CatalogEntry } from "./SatelliteCatalog";

export interface ActivationState {
  entries: Iterable<CatalogEntry>;
  enabledTags: readonly string[];
  enabledSatellites: readonly string[];
  // Names opted out of tag-activation (does not beat enabledSatellites/tracking).
  disabledSatellites?: readonly string[];
  trackedName?: string;
  pendingTrackedName?: string;
}

// The single definition of "enabled via some tag" — also used by the
// SatelliteBrowser row model, so UI state and manager reconciliation cannot
// diverge.
export function isEnabledByTag(entry: CatalogEntry, tagSet: ReadonlySet<string>): boolean {
  return entry.tags.some((tag) => tagSet.has(tag));
}

// Deduplicates by key: a satellite enabled by both tag and name (or tracked)
// appears once.
export function activeTargetEntries(state: ActivationState): Map<string, CatalogEntry> {
  const enabledTags = new Set(state.enabledTags);
  const enabledSatellites = new Set(state.enabledSatellites);
  const disabledSatellites = new Set(state.disabledSatellites ?? []);
  const target = new Map<string, CatalogEntry>();

  for (const entry of state.entries) {
    const enabledByTag = isEnabledByTag(entry, enabledTags) && !disabledSatellites.has(entry.name);
    const enabledByName = enabledSatellites.has(entry.name);
    const enabledByTrack = entry.name === state.trackedName || entry.name === state.pendingTrackedName;
    if (enabledByTag || enabledByName || enabledByTrack) {
      target.set(entry.key, entry);
    }
  }

  return target;
}

/**
 * The order satellites should be instantiated in, tracked one first.
 *
 * Building a large activation is spread over frames (see SatelliteManager's
 * build queue), so position in this list is how long something waits. The
 * tracked satellite is the one with the camera and a `pendingTrackedSatellite`
 * resolution waiting on it, and at five thousand entries the difference between
 * first and last is seconds.
 */
export function buildOrder(entries: Iterable<[string, CatalogEntry]>, trackedName?: string): [string, CatalogEntry][] {
  const ordered = [...entries];
  if (!trackedName) {
    return ordered;
  }
  const index = ordered.findIndex(([, entry]) => entry.name === trackedName);
  if (index <= 0) {
    // Absent, or already first — either way there is nothing to move.
    return ordered;
  }
  const [tracked] = ordered.splice(index, 1);
  return tracked ? [tracked, ...ordered] : ordered;
}

// Pure target-set computation for lazy satellite instantiation.
//
// Given the catalog entries and the current activation state (enabled tags,
// enabled satellite names, tracked/pending-tracked names), compute the set of
// catalog entry keys that should have a live SatelliteComponentCollection.
//
// A satellite is a target if ANY of the following holds (OR semantics):
//   - one of its tags is in `enabledTags`
//   - its name is in `enabledSatellites`
//   - its name equals the currently tracked satellite name
//   - its name equals the pending-tracked satellite name
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
  trackedName?: string;
  pendingTrackedName?: string;
}

// Returns the map of catalog entry keys to entries that should be active.
// Deduplicates by key: a satellite enabled by both tag and name (or tracked)
// appears once.
export function activeTargetEntries(state: ActivationState): Map<string, CatalogEntry> {
  const enabledTags = new Set(state.enabledTags);
  const enabledSatellites = new Set(state.enabledSatellites);
  const target = new Map<string, CatalogEntry>();

  for (const entry of state.entries) {
    const enabledByTag = entry.tags.some((tag) => enabledTags.has(tag));
    const enabledByName = enabledSatellites.has(entry.name);
    const enabledByTrack = entry.name === state.trackedName || entry.name === state.pendingTrackedName;
    if (enabledByTag || enabledByName || enabledByTrack) {
      target.set(entry.key, entry);
    }
  }

  return target;
}

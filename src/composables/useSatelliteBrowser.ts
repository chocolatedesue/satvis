// useSatelliteBrowser — module-scoped state + derived row model for the
// SatelliteBrowser panel. State lives at module scope (not inside the setup
// function) so search text, expansion and scroll position survive the panel
// being remounted (Satvis mounts the panel behind a v-show; a v-if fallback
// for the virtualizer would remount it, and this keeps that transparent).
//
// The catalog itself is intentionally NOT reactive (it holds ~2k plain
// entries). Instead the store exposes `catalogRevision`, bumped by
// SatelliteManager.updateStore() whenever groups load. Every computed here
// touches `catalogRevision.value` so it recomputes as groups arrive, while
// reading the actual entries imperatively from `cc.sats.catalog`.
//
// Writes only ever target the Pinia store, replacing the whole array (the
// url-sync plugin's $subscribe requires a new array reference to detect the
// change). Satvis.vue's watchers propagate store -> cc.sats — this composable
// never writes cc.sats directly.

import { storeToRefs } from "pinia";
import { computed, onScopeDispose, ref } from "vue";

import { useSatStore } from "../stores/sat";

export type BrowserRow =
  | {
      kind: "group";
      id: string;
      tag: string;
      count: number;
      activeCount: number;
      state: "all" | "some" | "none";
      expanded: boolean;
    }
  | {
      kind: "sat";
      id: string;
      name: string;
      satnum: string;
      checked: boolean;
      viaGroup: boolean;
      groupsLabel?: string;
    };

const SEARCH_DEBOUNCE_MS = 150;

// --- Module-scoped state (survives panel remounts) ---
const searchQuery = ref("");
const debouncedQuery = ref("");
// Collapsed by default: an empty set means every group is collapsed.
const expandedGroups = ref<Set<string>>(new Set());

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let subscribers = 0;

function scheduleDebounce(): void {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debouncedQuery.value = searchQuery.value.trim();
    debounceTimer = undefined;
  }, SEARCH_DEBOUNCE_MS);
}

export function useSatelliteBrowser() {
  const satStore = useSatStore();
  const { availableGroups, catalogRevision, enabledSatellites, enabledTags } = storeToRefs(satStore);

  subscribers += 1;
  onScopeDispose(() => {
    subscribers -= 1;
    // Leave module state intact for the next mount; only drop the timer if no
    // component instance is left to observe the debounce result.
    if (subscribers === 0 && debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  });

  function setSearchQuery(value: string): void {
    searchQuery.value = value;
    scheduleDebounce();
  }

  function clearSearch(): void {
    searchQuery.value = "";
    debouncedQuery.value = "";
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  }

  // Precomputed search index: one entry per catalog satellite with a cheap,
  // uppercased match key (nameUpper already exists on the entry). Recomputed
  // only when the catalog revision bumps.
  const searchIndex = computed<{ entry: import("../modules/SatelliteCatalog").CatalogEntry; key: string }[]>(() => {
    void catalogRevision.value;
    return globalThis.cc.sats.catalog.entries.map((entry) => ({
      entry,
      key: `${entry.nameUpper} ${entry.satnum}`,
    }));
  });

  // Set of currently enabled tags, for fast membership tests.
  const enabledTagSet = computed(() => new Set(enabledTags.value));
  const enabledSatSet = computed(() => new Set(enabledSatellites.value));

  // Union of all active satellite names (via tag membership OR individual
  // selection). Also drives group activeCount and the summary bar.
  const activeSatNames = computed<Set<string>>(() => {
    void catalogRevision.value;
    const { catalog } = globalThis.cc.sats;
    const active = new Set(enabledSatellites.value);
    for (const tag of enabledTags.value) {
      for (const entry of catalog.entriesWithTag(tag)) {
        active.add(entry.name);
      }
    }
    return active;
  });

  const activeSatCount = computed(() => activeSatNames.value.size);

  // Per-tag stats: total member count and how many are active. A tag that is
  // enabled activates all of its members; otherwise a member counts as active
  // if it is individually selected or active via another enabled tag.
  const groupStats = computed<Map<string, { count: number; activeCount: number }>>(() => {
    void catalogRevision.value;
    const { catalog } = globalThis.cc.sats;
    const stats = new Map<string, { count: number; activeCount: number }>();
    for (const { tag } of availableGroups.value) {
      const members = catalog.entriesWithTag(tag);
      const count = members.length;
      let activeCount: number;
      if (enabledTagSet.value.has(tag)) {
        activeCount = count;
      } else {
        activeCount = 0;
        for (const member of members) {
          if (enabledSatSet.value.has(member.name) || member.tags.some((t) => t !== tag && enabledTagSet.value.has(t))) {
            activeCount += 1;
          }
        }
      }
      stats.set(tag, { count, activeCount });
    }
    return stats;
  });

  function groupState(tag: string, count: number, activeCount: number): "all" | "some" | "none" {
    if (enabledTagSet.value.has(tag) || (count > 0 && activeCount === count)) {
      return "all";
    }
    return activeCount > 0 ? "some" : "none";
  }

  // The flat list the virtualizer renders. Two modes:
  //   Tree mode (no query): alphabetical group rows; expanded groups are
  //     followed by their member sat rows.
  //   Search mode: matching group rows first, then flat deduped sat rows whose
  //     match key contains the query, each annotated with its group labels.
  const rows = computed<BrowserRow[]>(() => {
    void catalogRevision.value;
    const stats = groupStats.value;
    const active = activeSatNames.value;
    const groups = availableGroups.value.toSorted((a, b) => a.tag.localeCompare(b.tag));
    const query = debouncedQuery.value.toUpperCase();

    if (query === "") {
      const result: BrowserRow[] = [];
      for (const { tag } of groups) {
        const stat = stats.get(tag) ?? { count: 0, activeCount: 0 };
        const expanded = expandedGroups.value.has(tag);
        result.push({
          kind: "group",
          id: `g:${tag}`,
          tag,
          count: stat.count,
          activeCount: stat.activeCount,
          state: groupState(tag, stat.count, stat.activeCount),
          expanded,
        });
        if (expanded) {
          const members = globalThis.cc.sats.catalog.entriesWithTag(tag).toSorted((a, b) => a.name.localeCompare(b.name));
          for (const member of members) {
            const viaGroup = enabledTagSet.value.has(tag) || member.tags.some((t) => enabledTagSet.value.has(t));
            result.push({
              kind: "sat",
              id: `s:${tag}:${member.name}`,
              name: member.name,
              satnum: member.satnum,
              checked: active.has(member.name),
              viaGroup,
            });
          }
        }
      }
      return result;
    }

    // Search mode.
    const result: BrowserRow[] = [];
    for (const { tag } of groups) {
      if (!tag.toUpperCase().includes(query)) {
        continue;
      }
      const stat = stats.get(tag) ?? { count: 0, activeCount: 0 };
      result.push({
        kind: "group",
        id: `g:${tag}`,
        tag,
        count: stat.count,
        activeCount: stat.activeCount,
        state: groupState(tag, stat.count, stat.activeCount),
        expanded: false,
      });
    }
    const seen = new Set<string>();
    for (const { entry, key } of searchIndex.value) {
      if (!key.includes(query) || seen.has(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      const viaGroup = entry.tags.some((t) => enabledTagSet.value.has(t));
      result.push({
        kind: "sat",
        id: `s:${entry.name}`,
        name: entry.name,
        satnum: entry.satnum,
        checked: active.has(entry.name),
        viaGroup,
        groupsLabel: entry.tags.length > 0 ? entry.tags.join(", ") : undefined,
      });
    }
    return result;
  });

  // --- Actions (whole-array writes to the store only) ---

  // Toggle a whole group. Never touches enabledSatellites — the old "promote
  // full individual selection to a tag" behavior is deliberately dropped, and
  // group ops never bulk-write sats= so the URL can't explode.
  function toggleGroup(tag: string): void {
    if (enabledTagSet.value.has(tag)) {
      enabledTags.value = enabledTags.value.filter((t) => t !== tag);
    } else {
      enabledTags.value = [...enabledTags.value, tag];
    }
  }

  // Toggle an individual satellite. No-op if the satellite is already active
  // via an enabled group (OR activation semantics; the only way to deselect it
  // would be to disable the group). A future `xsats=` exclusion URL param is
  // the intended path to real per-member opt-out.
  function toggleSat(name: string): void {
    const entry = globalThis.cc.sats.catalog.getByName(name);
    if (entry && entry.tags.some((t) => enabledTagSet.value.has(t))) {
      return;
    }
    if (enabledSatSet.value.has(name)) {
      enabledSatellites.value = enabledSatellites.value.filter((s) => s !== name);
    } else {
      enabledSatellites.value = [...enabledSatellites.value, name];
    }
  }

  function toggleExpand(tag: string): void {
    const next = new Set(expandedGroups.value);
    if (next.has(tag)) {
      next.delete(tag);
    } else {
      next.add(tag);
    }
    expandedGroups.value = next;
  }

  function clearAll(): void {
    enabledTags.value = [];
    enabledSatellites.value = [];
  }

  const hasActiveSelection = computed(() => enabledTags.value.length > 0 || enabledSatellites.value.length > 0);
  const groupCount = computed(() => enabledTags.value.length);
  const isLoading = computed(() => {
    void catalogRevision.value;
    return availableGroups.value.length === 0;
  });

  return {
    searchQuery,
    debouncedQuery,
    setSearchQuery,
    clearSearch,
    availableGroups,
    enabledTags,
    rows,
    activeSatCount,
    groupCount,
    hasActiveSelection,
    isLoading,
    toggleGroup,
    toggleSat,
    toggleExpand,
    clearAll,
  };
}

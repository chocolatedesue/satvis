// SatelliteCatalog — the frontend's plain, non-reactive registry of known
// satellites, decoupled from instantiated Cesium objects. It owns O(n) dedup
// and tag merging (previously O(n²) Array.find in SatelliteManager.#add).
//
// This module must stay Cesium-free (node-env vitest exercises it).

import { appMetadataConfig, type MetadataRule, type ResolvedMetadata } from "../config/satelliteMetadata";
import { parseGpPayload, recordName, recordSatnum, type GpRecord } from "./util/gp";
import { resolveGpBase, resolveGpSource, resolveGroupUrl, resolveMetadataUrl, staticGroupUrl } from "./util/gpSource";

// A single known satellite. Created by SatelliteCatalog.addRecords, which owns
// the identity/tag indices; the entry keeps a back-reference to its catalog so
// `metadata` can resolve lazily against the current rule set. The dependency is
// explicit (constructor arg) rather than closed over, so there is no this-alias.
export class CatalogEntry {
  // Dedup identity, matching today's SatelliteManager.#add: satnum + "|" + name.
  readonly key: string;

  readonly name: string;

  readonly nameUpper: string;

  readonly satnum: string;

  // Mutable: addRecords reassigns it when merging tags across groups.
  tags: string[];

  readonly record: GpRecord;

  // Per-entry memoized resolved metadata, tagged with the catalog metadata
  // revision it was computed against. Invalidated implicitly when the catalog's
  // revision bumps (mergeMetadataConfig), so a stale cache is never returned.
  #cache: { revision: number; metadata: ResolvedMetadata } | undefined;

  constructor(
    private readonly catalog: SatelliteCatalog,
    fields: { key: string; name: string; nameUpper: string; satnum: string; tags: string[]; record: GpRecord },
  ) {
    this.key = fields.key;
    this.name = fields.name;
    this.nameUpper = fields.nameUpper;
    this.satnum = fields.satnum;
    this.tags = fields.tags;
    this.record = fields.record;
  }

  // Resolved per-satellite metadata (swath, cone FOV, model URL). Resolved
  // lazily via the catalog and memoized against its metadata revision, so
  // entries created before remote rules arrive still see the merged result.
  get metadata(): ResolvedMetadata {
    const revision = this.catalog.metadataRevision;
    if (this.#cache && this.#cache.revision === revision) {
      return this.#cache.metadata;
    }
    const metadata = this.catalog.resolveMetadata(this);
    this.#cache = { revision, metadata };
    return metadata;
  }
}

// A rule paired with its compiled RegExp (compiled once, on first match).
interface CompiledRule {
  rule: MetadataRule;
  pattern: RegExp | undefined;
}

// A preset group source known to the catalog but fetched lazily: registered
// up front (so the UI can list it), loaded only once one of its tags becomes
// active, it is expanded/searched in the browser, or an unresolved satellite
// name forces a full load.
interface RegisteredGroup {
  source: string;
  tags: string[];
  loaded: boolean;
  // Memoized in-flight/completed load; cleared on failure so a later ensure
  // call retries.
  load: Promise<void> | undefined;
}

export type CatalogChangeCallback = (entries: CatalogEntry[]) => void;

export class SatelliteCatalog {
  #byKey = new Map<string, CatalogEntry>();

  #byName = new Map<string, CatalogEntry>();

  #bySatnum = new Map<string, CatalogEntry[]>();

  #byTag = new Map<string, Set<CatalogEntry>>();

  // Metadata rules: app rules first, then remote rules appended by
  // mergeMetadataConfig (remote wins field-wise). RegExps are compiled lazily
  // and cached per rule. The revision bumps whenever the rule set changes,
  // invalidating per-entry memoized metadata.
  #compiledRules: CompiledRule[] = appMetadataConfig.rules.map((rule) => ({ rule, pattern: undefined }));

  #metadataRevision = 0;

  // Current metadata rule-set revision. Read by CatalogEntry to key its memo;
  // bumped by mergeMetadataConfig to invalidate every entry's cached metadata.
  get metadataRevision(): number {
    return this.#metadataRevision;
  }

  #changeCallbacks: CatalogChangeCallback[] = [];

  onChange(cb: CatalogChangeCallback): void {
    this.#changeCallbacks.push(cb);
  }

  #notifyChange(entries: CatalogEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    this.#changeCallbacks.forEach((cb) => cb(entries));
  }

  // Lazily-loaded preset groups by source name, plus per-source record counts
  // from the group index (display estimates for not-yet-loaded groups).
  #registry = new Map<string, RegisteredGroup>();

  #indexCounts = new Map<string, number>();

  #indexLoad: Promise<void> | undefined;

  #metadataLoad: Promise<void> | undefined;

  // Register preset groups without fetching them. Repeated registration (e.g.
  // navigating between presets) merges tags; already-loaded groups stay loaded.
  registerGroups(sourceTagList: ReadonlyArray<readonly [string, string[]]>): void {
    for (const [source, tags] of sourceTagList) {
      const existing = this.#registry.get(source);
      if (existing) {
        existing.tags = mergeTags(existing.tags, tags);
        continue;
      }
      this.#registry.set(source, { source, tags: [...tags], loaded: false, load: undefined });
    }
  }

  // Fetch the group index (names + record counts) so unloaded groups can show
  // an estimated count in the UI. Best-effort: an unavailable index just leaves
  // the estimates at 0.
  ensureIndex(): Promise<void> {
    this.#indexLoad ??= resolveGpSource().then((info) => {
      for (const group of info.index) {
        if (typeof group.count === "number") {
          this.#indexCounts.set(group.name, group.count);
        }
      }
    });
    return this.#indexLoad;
  }

  // Load every registered group carrying one of the given tags. Loads are
  // memoized per group; per-group errors are logged and skipped.
  ensureTags(tags: readonly string[]): Promise<void> {
    const wanted = new Set(tags);
    const loads = [...this.#registry.values()].filter((group) => group.tags.some((tag) => wanted.has(tag))).map((group) => this.#ensureGroup(group));
    return Promise.all(loads).then(() => undefined);
  }

  // Load every registered group (needed for cross-group search and for
  // satellite names whose group is unknown, e.g. URL-enabled sats).
  ensureAll(): Promise<void> {
    const loads = [...this.#registry.values()].map((group) => this.#ensureGroup(group));
    return Promise.all(loads).then(() => undefined);
  }

  // True once every registered group carrying the tag has loaded (trivially
  // true for tags without a registered source, e.g. custom records).
  isTagLoaded(tag: string): boolean {
    for (const group of this.#registry.values()) {
      if (!group.loaded && group.tags.includes(tag)) {
        return false;
      }
    }
    return true;
  }

  #ensureGroup(group: RegisteredGroup): Promise<void> {
    group.load ??= this.#loadRegisteredGroup(group);
    return group.load;
  }

  async #loadRegisteredGroup(group: RegisteredGroup): Promise<void> {
    const base = await resolveGpBase();
    // Fetch metadata (once) BEFORE the first group file so ground tracks /
    // cones aren't created with stale widths.
    await (this.#metadataLoad ??= this.#loadMetadata(base));
    try {
      const text = await this.#fetchGroupPayload(group.source, base);
      const records = parseGpPayload(text);
      const changed = this.addRecords(records, group.tags);
      group.loaded = true;
      this.#notifyChange(changed);
    } catch (error) {
      console.log(error);
      // Clear the memoized load so a later ensure call retries.
      group.load = undefined;
    }
  }

  // Fetch a group payload from the resolved base; when the worker API fails
  // mid-session (network error or non-2xx), retry once against the static
  // snapshot bundled with the build.
  async #fetchGroupPayload(source: string, base: string): Promise<string> {
    const url = resolveGroupUrl(source, base);
    try {
      // Plain fetch (NOT mode:"no-cors") — the API is same-origin; an opaque
      // response would have an unreadable body and break parsing.
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      return await response.text();
    } catch (error) {
      const fallback = staticGroupUrl(source);
      if (fallback === undefined || fallback === url) {
        throw error;
      }
      console.log(`GP fetch failed for ${url}, retrying static snapshot ${fallback}`, error);
      const response = await fetch(fallback);
      if (!response.ok) {
        throw new Error(response.statusText, { cause: error });
      }
      return await response.text();
    }
  }

  // Fetch and merge remote metadata rules. Tolerant of worker-less / older
  // deployments: any failure (404, network, invalid body) logs and continues
  // with the built-in app defaults.
  async #loadMetadata(base: string): Promise<void> {
    const url = resolveMetadataUrl(base);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      const remote = (await response.json()) as unknown;
      if (!Array.isArray(remote)) {
        throw new Error("metadata payload is not an array");
      }
      this.mergeMetadataConfig(remote as MetadataRule[]);
    } catch (error) {
      console.log(error);
    }
  }

  // Add records with the given tags, deduping by key and merging tags. Returns
  // the entries that were added or whose tags changed (for the change callback).
  addRecords(records: GpRecord[], tags: string[]): CatalogEntry[] {
    const changed: CatalogEntry[] = [];
    for (const record of records) {
      const name = recordName(record);
      const satnum = recordSatnum(record);
      const key = `${satnum}|${name}`;
      const existing = this.#byKey.get(key);
      if (existing) {
        const before = existing.tags.length;
        existing.tags = mergeTags(existing.tags, tags);
        if (existing.tags.length !== before) {
          this.#indexTags(existing);
          changed.push(existing);
        }
        continue;
      }
      const entry = new CatalogEntry(this, {
        key,
        name,
        nameUpper: name.toUpperCase(),
        satnum,
        tags: [...tags],
        record,
      });
      this.#byKey.set(key, entry);
      // First-wins by name (matches today's getSatellite lookup).
      if (!this.#byName.has(name)) {
        this.#byName.set(name, entry);
      }
      const satnumEntries = this.#bySatnum.get(satnum) ?? [];
      satnumEntries.push(entry);
      this.#bySatnum.set(satnum, satnumEntries);
      this.#indexTags(entry);
      changed.push(entry);
    }
    return changed;
  }

  #indexTags(entry: CatalogEntry): void {
    for (const tag of entry.tags) {
      const tagEntries = this.#byTag.get(tag) ?? new Set();
      tagEntries.add(entry);
      this.#byTag.set(tag, tagEntries);
    }
  }

  // Append remote metadata rules after the built-in app rules (remote wins
  // field-wise, being merged last). Bumps the metadata revision so previously
  // memoized per-entry metadata is recomputed on next access.
  mergeMetadataConfig(remoteRules: MetadataRule[]): void {
    for (const rule of remoteRules) {
      this.#compiledRules.push({ rule, pattern: undefined });
    }
    this.#metadataRevision += 1;
  }

  // Resolve metadata for an entry: start from app defaults, then shallow-merge
  // the metadata of every matching rule in order. Package-visible (not #private)
  // so CatalogEntry.metadata can delegate here; memoization lives in the entry,
  // keyed by metadataRevision. The result is a ResolvedMetadata because it
  // spreads `defaults` (which supplies the required fields), and rules only ever
  // overwrite those fields with values of the same type.
  resolveMetadata(entry: CatalogEntry): ResolvedMetadata {
    const metadata: ResolvedMetadata = { ...appMetadataConfig.defaults };
    for (const compiled of this.#compiledRules) {
      if (this.#ruleMatches(compiled, entry)) {
        Object.assign(metadata, compiled.rule.metadata);
      }
    }
    return metadata;
  }

  #ruleMatches(compiled: CompiledRule, entry: CatalogEntry): boolean {
    const { match } = compiled.rule;
    if (match.satnums?.includes(entry.satnum)) {
      return true;
    }
    if (match.names?.includes(entry.name)) {
      return true;
    }
    if (match.namePattern) {
      // Compile once per rule and cache.
      compiled.pattern ??= new RegExp(match.namePattern);
      if (compiled.pattern.test(entry.name)) {
        return true;
      }
    }
    return false;
  }

  // All known groups: tags with loaded entries (exact counts) plus registered
  // but not-yet-loaded sources (estimated counts from the group index, 0 until
  // the index arrives). Estimates may double-count satellites shared with a
  // loaded group; they are replaced by exact counts once the group loads.
  get groups(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const [tag, entries] of this.#byTag) {
      counts.set(tag, entries.size);
    }
    for (const group of this.#registry.values()) {
      if (group.loaded) {
        continue;
      }
      const estimate = this.#indexCounts.get(group.source) ?? 0;
      for (const tag of group.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + estimate);
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  }

  entriesWithTag(tag: string): CatalogEntry[] {
    return [...(this.#byTag.get(tag) ?? [])];
  }

  getByName(name: string): CatalogEntry | undefined {
    return this.#byName.get(name);
  }

  get size(): number {
    return this.#byKey.size;
  }

  get entries(): CatalogEntry[] {
    return [...this.#byKey.values()];
  }
}

// Union merge preserving order.
function mergeTags(existing: string[], added: string[]): string[] {
  const result = [...existing];
  for (const tag of added) {
    if (!result.includes(tag)) {
      result.push(tag);
    }
  }
  return result;
}

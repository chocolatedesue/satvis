// SatelliteCatalog — the frontend's plain, non-reactive registry of known
// satellites, decoupled from instantiated Cesium objects. It owns O(n) dedup
// and tag merging (previously O(n²) Array.find in SatelliteManager.#add).
//
// This module must stay Cesium-free (node-env vitest exercises it).

import { appMetadataConfig, type MetadataRule, type SatelliteMetadata } from "../config/satelliteMetadata";
import { parseGpPayload, recordName, recordSatnum, type GpRecord } from "./util/gp";
import { resolveGpBase, resolveGroupUrl, resolveMetadataUrl } from "./util/gpSource";

export interface CatalogEntry {
  // Dedup identity, matching today's SatelliteManager.#add: satnum + "|" + name.
  key: string;
  name: string;
  nameUpper: string;
  satnum: string;
  tags: string[];
  record: GpRecord;
  // Resolved per-satellite metadata (swath, cone FOV, model URL). Memoized
  // lazily and invalidated when the metadata revision bumps (see #resolveMetadata).
  readonly metadata: SatelliteMetadata;
}

// A rule paired with its compiled RegExp (compiled once, on first match).
interface CompiledRule {
  rule: MetadataRule;
  pattern: RegExp | undefined;
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

  // Per-entry memoized resolved metadata, keyed by entry key, tagged with the
  // revision it was computed against.
  #metadataCache = new Map<string, { revision: number; metadata: SatelliteMetadata }>();

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

  // Load all preset groups: resolve the base once, then fetch all groups in
  // parallel. Per-URL errors are logged and skipped (log-and-continue, matching
  // today's behavior). onChange fires once per group batch.
  async loadGroups(sourceTagList: ReadonlyArray<readonly [string, string[]]>): Promise<void> {
    const base = await resolveGpBase();
    // Fetch metadata BEFORE the group files so ground tracks / cones aren't
    // created with stale widths. 404/invalid is log-and-continue (app defaults).
    await this.#loadMetadata(base);
    await Promise.all(sourceTagList.map(([source, tags]) => this.#loadGroupWithBase(source, tags, base)));
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

  async loadGroup(url: string, tags: string[]): Promise<void> {
    const base = await resolveGpBase();
    await this.#loadGroupWithBase(url, tags, base);
  }

  async #loadGroupWithBase(source: string, tags: string[], base: string): Promise<void> {
    const url = resolveGroupUrl(source, base);
    try {
      // Plain fetch (NOT mode:"no-cors") — the API is same-origin; an opaque
      // response would have an unreadable body and break parsing.
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      const text = await response.text();
      const records = parseGpPayload(text);
      const changed = this.addRecords(records, tags);
      this.#notifyChange(changed);
    } catch (error) {
      console.log(error);
    }
  }

  // Add records with the given tags, deduping by key and merging tags. Returns
  // the entries that were added or whose tags changed (for the change callback).
  addRecords(records: GpRecord[], tags: string[]): CatalogEntry[] {
    // Captured by each entry's metadata getter so it can reach the resolver.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const catalog = this;
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
      const entry: CatalogEntry = {
        key,
        name,
        nameUpper: name.toUpperCase(),
        satnum,
        tags: [...tags],
        record,
        // Lazily resolved + memoized against the catalog's metadata revision.
        // A getter (rather than a stored value) keeps entries in sync when
        // remote rules arrive after the entry was created.
        get metadata(): SatelliteMetadata {
          return catalog.#resolveMetadata(this as CatalogEntry);
        },
      };
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
  // the metadata of every matching rule in order. Memoized per entry, keyed by
  // the current metadata revision.
  #resolveMetadata(entry: CatalogEntry): SatelliteMetadata {
    const cached = this.#metadataCache.get(entry.key);
    if (cached && cached.revision === this.#metadataRevision) {
      return cached.metadata;
    }
    const metadata: SatelliteMetadata = { ...appMetadataConfig.defaults };
    for (const compiled of this.#compiledRules) {
      if (this.#ruleMatches(compiled, entry)) {
        Object.assign(metadata, compiled.rule.metadata);
      }
    }
    this.#metadataCache.set(entry.key, { revision: this.#metadataRevision, metadata });
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

  get groups(): { tag: string; count: number }[] {
    return [...this.#byTag.entries()].map(([tag, entries]) => ({ tag, count: entries.size }));
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

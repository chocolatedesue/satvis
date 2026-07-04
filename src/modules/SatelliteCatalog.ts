// SatelliteCatalog — the frontend's plain, non-reactive registry of known
// satellites, decoupled from instantiated Cesium objects. It owns O(n) dedup
// and tag merging (previously O(n²) Array.find in SatelliteManager.#add).
//
// This module must stay Cesium-free (node-env vitest exercises it).

import { parseGpPayload, recordName, recordSatnum, type GpRecord } from "./util/gp";
import { resolveGpBase, resolveGroupUrl } from "./util/gpSource";

export interface CatalogEntry {
  // Dedup identity, matching today's SatelliteManager.#add: satnum + "|" + name.
  key: string;
  name: string;
  nameUpper: string;
  satnum: string;
  tags: string[];
  record: GpRecord;
}

export type CatalogChangeCallback = (entries: CatalogEntry[]) => void;

export class SatelliteCatalog {
  #byKey = new Map<string, CatalogEntry>();

  #byName = new Map<string, CatalogEntry>();

  #bySatnum = new Map<string, CatalogEntry[]>();

  #byTag = new Map<string, CatalogEntry[]>();

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
    await Promise.all(sourceTagList.map(([source, tags]) => this.#loadGroupWithBase(source, tags, base)));
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
      const tagEntries = this.#byTag.get(tag) ?? [];
      if (!tagEntries.includes(entry)) {
        tagEntries.push(entry);
      }
      this.#byTag.set(tag, tagEntries);
    }
  }

  get tags(): string[] {
    return [...this.#byTag.keys()];
  }

  get groups(): { tag: string; count: number }[] {
    return [...this.#byTag.entries()].map(([tag, entries]) => ({ tag, count: entries.length }));
  }

  entriesWithTag(tag: string): CatalogEntry[] {
    return this.#byTag.get(tag) ?? [];
  }

  getByName(name: string): CatalogEntry | undefined {
    return this.#byName.get(name);
  }

  // tag -> sorted names — the shape the Pinia store consumes today.
  taglist(): Record<string, string[]> {
    const taglist: Record<string, string[]> = {};
    for (const [tag, entries] of this.#byTag.entries()) {
      taglist[tag] = entries.map((entry) => entry.name).toSorted();
    }
    return taglist;
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

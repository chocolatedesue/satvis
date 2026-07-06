// GroupStore — the persistence seam of the GP refresh pipeline. The refresh
// itself is store-agnostic (see refresh.ts); two adapters exist: Workers KV
// (cron and API, below) and the static data/gp/ snapshot on disk
// (scripts/update-static-gp.mjs).

import { coerceIndex } from "./evaluate.ts";
import type { GpRecord, GroupsIndex } from "./types.ts";

export const GP_KEY_PREFIX = "gp:";
export const GP_INDEX_KEY = "gp:index";

// Per-group value metadata stored alongside each group's records and read
// back by the API to build ETag / Last-Modified headers.
export interface GroupWriteMetadata {
  updated: string;
  count: number;
}

export interface GroupStore {
  /** The last written index; empty (coerced) when missing or corrupt. */
  readIndex(): Promise<GroupsIndex>;
  writeGroup(name: string, records: GpRecord[], metadata: GroupWriteMetadata): Promise<void>;
  writeIndex(index: GroupsIndex): Promise<void>;
}

export function kvGroupStore(kv: KVNamespace): GroupStore {
  return {
    async readIndex(): Promise<GroupsIndex> {
      return coerceIndex(await kv.get(GP_INDEX_KEY, "json"));
    },
    async writeGroup(name: string, records: GpRecord[], metadata: GroupWriteMetadata): Promise<void> {
      await kv.put(GP_KEY_PREFIX + name, JSON.stringify(records), { metadata });
    },
    async writeIndex(index: GroupsIndex): Promise<void> {
      await kv.put(GP_INDEX_KEY, JSON.stringify(index));
    },
  };
}

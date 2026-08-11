// GroupStore — the persistence seam of the GP refresh pipeline. The refresh
// itself is store-agnostic (see refresh.ts); two adapters exist: Workers KV
// (cron and API, below) and the static data/gp/ snapshot on disk
// (scripts/update-static-gp.mjs).

import { coerceIndex } from "./evaluate.ts";
import type { GpRecord, GroupsIndex, SatcatSnapshot } from "./types.ts";

export const GP_KEY_PREFIX = "gp:";
export const GP_INDEX_KEY = "gp:index";
export const SATCAT_KEY = "gp:satcat";

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
  /**
   * The stored SATCAT, or undefined when none has been fetched yet (or the
   * stored value is unreadable). Unlike the groups, this is read on every
   * refresh rather than only written: a conditional fetch that comes back 304
   * has no body, so the stored snapshot IS the input to enrichment.
   */
  readSatcat(): Promise<SatcatSnapshot | undefined>;
  writeSatcat(snapshot: SatcatSnapshot): Promise<void>;
}

// Reject a stored SATCAT value that is missing or the wrong shape, so a corrupt
// key degrades to "no SATCAT this run" rather than throwing mid-refresh.
function coerceSatcat(raw: unknown): SatcatSnapshot | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const { rows, updated } = raw as SatcatSnapshot;
  if (rows === null || typeof rows !== "object" || Array.isArray(rows) || typeof updated !== "string") {
    return undefined;
  }
  return raw as SatcatSnapshot;
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
    async readSatcat(): Promise<SatcatSnapshot | undefined> {
      return coerceSatcat(await kv.get(SATCAT_KEY, "json"));
    },
    async writeSatcat(snapshot: SatcatSnapshot): Promise<void> {
      await kv.put(SATCAT_KEY, JSON.stringify(snapshot));
    },
  };
}

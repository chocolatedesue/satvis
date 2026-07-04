// Worker-side refresh: fetch every source, evaluate every group, and persist
// successful groups to KV while preserving last-known-good on failure.

import config from "../config/groups.generated.json" with { type: "json" };
import { evaluateGroups, fetchSources } from "./evaluate.ts";
import type { GroupsConfig, GroupsIndex, GroupStatus } from "./types.ts";

const groupsConfig = config as GroupsConfig;

export const GP_KEY_PREFIX = "gp:";
export const GP_INDEX_KEY = "gp:index";

interface KvValueMetadata {
  updated: string;
  count: number;
}

// Fetch upstream, evaluate, and write results to KV. Failed groups are skipped
// so their last-known-good value stays in KV; the rebuilt index merges the
// previous index so failed groups keep their old `updated` and gain
// lastError/lastErrorAt.
export async function refreshAll(env: Env): Promise<GroupsIndex> {
  const now = new Date().toISOString();
  const defs = groupsConfig.groups;

  const recordsBySource = await fetchSources(defs, (url, init) => fetch(url, init));
  const evaluated = evaluateGroups(defs, recordsBySource);

  const previous = await readIndex(env);
  const previousByName = new Map(previous.groups.map((status) => [status.name, status]));

  const statuses: GroupStatus[] = [];
  for (const def of defs) {
    const result = evaluated.get(def.name);
    const prev = previousByName.get(def.name);
    if (result === undefined || result instanceof Error) {
      const message = result instanceof Error ? result.message : "not evaluated";
      // Skip the KV write so the last-known-good value stays intact.
      statuses.push({
        name: def.name,
        updated: prev?.updated ?? null,
        count: prev?.count ?? 0,
        lastError: message,
        lastErrorAt: now,
      });
      continue;
    }
    const metadata: KvValueMetadata = { updated: now, count: result.length };
    await env.GP_KV.put(GP_KEY_PREFIX + def.name, JSON.stringify(result), { metadata });
    statuses.push({ name: def.name, updated: now, count: result.length });
  }

  const index: GroupsIndex = { updated: now, groups: statuses };
  await env.GP_KV.put(GP_INDEX_KEY, JSON.stringify(index));
  return index;
}

async function readIndex(env: Env): Promise<GroupsIndex> {
  const raw = await env.GP_KV.get(GP_INDEX_KEY, "json");
  if (raw && typeof raw === "object" && Array.isArray((raw as GroupsIndex).groups)) {
    return raw as GroupsIndex;
  }
  return { updated: "", groups: [] };
}

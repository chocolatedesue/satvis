// Worker-side refresh: fetch every source, evaluate every group, and persist
// successful groups to KV while preserving last-known-good on failure.

import config from "../config/groups.generated.json" with { type: "json" };
import { buildStatuses, coerceIndex, evaluateGroups, fetchSources } from "./evaluate.ts";
import type { GroupsConfig, GroupsIndex } from "./types.ts";

const groupsConfig = config as GroupsConfig;

export const GP_KEY_PREFIX = "gp:";
export const GP_INDEX_KEY = "gp:index";

interface KvValueMetadata {
  updated: string;
  count: number;
}

// Fetch upstream, evaluate, and write results to KV. Failed groups are skipped
// so their last-known-good value stays in KV; the rebuilt index (see
// buildStatuses) keeps their old `updated` and gains lastError/lastErrorAt.
export async function refreshAll(env: Env): Promise<GroupsIndex> {
  const now = new Date().toISOString();
  const defs = groupsConfig.groups;

  const recordsBySource = await fetchSources(defs, (url, init) => fetch(url, init));
  const evaluated = evaluateGroups(defs, recordsBySource);
  const previous = coerceIndex(await env.GP_KV.get(GP_INDEX_KEY, "json"));
  const statuses = buildStatuses(defs, evaluated, previous, now);

  // Persist successful groups in parallel (independent keys). Failed groups
  // get no write, so their last-known-good value stays intact.
  await Promise.all(
    defs.map((def) => {
      const result = evaluated.get(def.name);
      if (result === undefined || result instanceof Error) {
        return undefined;
      }
      const metadata: KvValueMetadata = { updated: now, count: result.length };
      return env.GP_KV.put(GP_KEY_PREFIX + def.name, JSON.stringify(result), { metadata });
    }),
  );

  const index: GroupsIndex = { updated: now, groups: statuses };
  await env.GP_KV.put(GP_INDEX_KEY, JSON.stringify(index));
  return index;
}

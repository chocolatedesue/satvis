// Worker-side refresh: fetch every source, evaluate every group, and persist
// successful groups to KV while preserving last-known-good on failure.

import config from "../config/groups.generated.json" with { type: "json" };
import { buildStatuses, coerceIndex, collectSources, evaluateGroups, fetchSources, type SourceProbe, toProbe, toRecordsBySource } from "./evaluate.ts";
import type { GroupsConfig, GroupsIndex } from "./types.ts";

const groupsConfig = config as GroupsConfig;

export const GP_KEY_PREFIX = "gp:";
export const GP_INDEX_KEY = "gp:index";

// Per-group KV value metadata (stored alongside each gp:<name> entry and read
// back by the API to build ETag / Last-Modified headers).
export interface KvValueMetadata {
  updated: string;
  count: number;
}

// Result of one refresh run: the rebuilt index plus the per-source fetch
// diagnostics and write tallies, so a manual trigger (POST /api/refresh) can
// report exactly what happened. The cron ignores the return value.
export interface RefreshReport {
  index: GroupsIndex;
  sources: SourceProbe[];
  written: number;
  skipped: number;
  durationMs: number;
}

// Fetch upstream, evaluate, and write results to KV. Failed groups are skipped
// so their last-known-good value stays in KV; the rebuilt index (see
// buildStatuses) keeps their old `updated` and gains lastError/lastErrorAt.
export async function refreshAll(env: Env): Promise<RefreshReport> {
  const startedMs = Date.now();
  const now = new Date().toISOString();
  const defs = groupsConfig.groups;
  console.log(`gp refresh: start — ${defs.length} groups, ${collectSources(defs).length} sources`);

  const fetched = await fetchSources(defs, (url, init) => fetch(url, init));
  const evaluated = evaluateGroups(defs, toRecordsBySource(fetched));
  const previous = coerceIndex(await env.GP_KV.get(GP_INDEX_KEY, "json"));
  const statuses = buildStatuses(defs, evaluated, previous, now);

  // Persist successful groups in parallel (independent keys). Failed groups
  // get no write, so their last-known-good value stays intact.
  let written = 0;
  let skipped = 0;
  await Promise.all(
    defs.map((def) => {
      const result = evaluated.get(def.name);
      if (result === undefined || result instanceof Error) {
        skipped++;
        return undefined;
      }
      for (const warning of result.warnings) {
        console.warn(`gp refresh: ${def.name}: ${warning}`);
      }
      written++;
      const metadata: KvValueMetadata = { updated: now, count: result.records.length };
      return env.GP_KV.put(GP_KEY_PREFIX + def.name, JSON.stringify(result.records), { metadata });
    }),
  );

  const index: GroupsIndex = { updated: now, groups: statuses };
  await env.GP_KV.put(GP_INDEX_KEY, JSON.stringify(index));
  const durationMs = Date.now() - startedMs;
  console.log(`gp refresh: done in ${durationMs}ms — ${written} groups written, ${skipped} skipped/failed`);
  return { index, sources: fetched.map(toProbe), written, skipped, durationMs };
}

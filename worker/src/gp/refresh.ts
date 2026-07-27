// Store-agnostic refresh: fetch every source, evaluate every group, and
// persist successful groups while preserving last-known-good on failure.
// The worker cron/API run it against KV (refreshAll); the static snapshot
// generator runs the same pipeline against disk (scripts/update-static-gp.mjs).

import config from "../config/satvis.generated.json" with { type: "json" };
import { buildStatuses, collectSources, evaluateGroups, fetchSources, type FetchImpl, type SourceProbe, toProbe, toRecordsBySource } from "./evaluate.ts";
import { kvGroupStore, type GroupStore } from "./store.ts";
import type { GroupDefinition, GroupsConfig, GroupsIndex } from "./types.ts";

const groupsConfig = config as GroupsConfig;

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

// Fetch upstream, evaluate, and write results to the store. Failed groups are
// skipped so their last-known-good value stays in the store; the rebuilt index
// (see buildStatuses) keeps their old `updated` and gains lastError/lastErrorAt.
export async function refreshGroups(defs: GroupDefinition[], store: GroupStore, fetchImpl: FetchImpl): Promise<RefreshReport> {
  const startedMs = Date.now();
  const now = new Date().toISOString();
  console.log(`gp refresh: start — ${defs.length} groups, ${collectSources(defs).length} sources`);

  const fetched = await fetchSources(defs, fetchImpl);
  const evaluated = evaluateGroups(defs, toRecordsBySource(fetched));
  const previous = await store.readIndex();
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
      return store.writeGroup(def.name, result.records, { updated: now, count: result.records.length });
    }),
  );

  const index: GroupsIndex = { updated: now, groups: statuses };
  await store.writeIndex(index);
  const durationMs = Date.now() - startedMs;
  console.log(`gp refresh: done in ${durationMs}ms — ${written} groups written, ${skipped} skipped/failed`);
  return { index, sources: fetched.map(toProbe), written, skipped, durationMs };
}

// Worker entrypoint: bundled config, KV store, global fetch.
export async function refreshAll(env: Env): Promise<RefreshReport> {
  return refreshGroups(groupsConfig.groups, kvGroupStore(env.GP_KV), (url, init) => fetch(url, init));
}

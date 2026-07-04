// Pure, runtime-agnostic group evaluator. NO Cloudflare APIs here so it can be
// unit-tested and reused by the static generator via node type stripping.

import type { GpRecord, GroupDefinition, OmmRecord, SourceSpec } from "./types.ts";

const CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/";
const USER_AGENT = "satvis.space (https://github.com/Flowm/satvis)";
// CelesTrak asks clients to space out requests; keep sources sequential and
// gentle.
const REQUEST_SPACING_MS = 250;

// A stable, dedupable key for a source spec.
export function sourceKey(spec: SourceSpec): string {
  if ("celestrak" in spec) {
    return `celestrak:${spec.celestrak}`;
  }
  if ("celestrakSup" in spec) {
    return `celestrakSup:${spec.celestrakSup}`;
  }
  return `url:${spec.url}`;
}

// Resolve a source spec to its fetch URL.
export function sourceUrl(spec: SourceSpec): string {
  if ("celestrak" in spec) {
    return `${CELESTRAK_BASE}gp.php?GROUP=${encodeURIComponent(spec.celestrak)}&FORMAT=JSON`;
  }
  if ("celestrakSup" in spec) {
    return `${CELESTRAK_BASE}supplemental/sup-gp.php?FILE=${encodeURIComponent(spec.celestrakSup)}&FORMAT=JSON`;
  }
  return spec.url;
}

// Collect every distinct source across all group definitions (dedup by key).
export function collectSources(defs: GroupDefinition[]): SourceSpec[] {
  const seen = new Map<string, SourceSpec>();
  for (const def of defs) {
    for (const spec of def.sources ?? []) {
      const key = sourceKey(spec);
      if (!seen.has(key)) {
        seen.set(key, spec);
      }
    }
  }
  return [...seen.values()];
}

// Result of fetching every collected source. On failure a source maps to an
// Error rather than throwing, so a single bad upstream only breaks the groups
// that depend on it.
export type RecordsBySource = Map<string, OmmRecord[] | Error>;

type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Hard validation: CelesTrak serves HTML error pages with HTTP 200, so we must
// check the body shape, not just the status code.
function parseOmmArray(status: number, body: string): OmmRecord[] {
  if (status !== 200) {
    throw new Error(`HTTP ${status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`response is not JSON (starts with ${JSON.stringify(body.slice(0, 32))})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("response is not a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("response array is empty");
  }
  const first = parsed[0] as Record<string, unknown>;
  if (first === null || typeof first !== "object" || !("NORAD_CAT_ID" in first)) {
    throw new Error("first element is missing NORAD_CAT_ID");
  }
  return parsed as OmmRecord[];
}

// Fetch every collected source sequentially, spaced ~250 ms apart. Never
// throws: failed sources are recorded as Error values.
export async function fetchSources(defs: GroupDefinition[], fetchImpl: FetchImpl): Promise<RecordsBySource> {
  const specs = collectSources(defs);
  const result: RecordsBySource = new Map();
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const key = sourceKey(spec);
    if (i > 0) {
      await delay(REQUEST_SPACING_MS);
    }
    try {
      const res = await fetchImpl(sourceUrl(spec), { headers: { "User-Agent": USER_AGENT } });
      result.set(key, parseOmmArray(res.status, await res.text()));
    } catch (err) {
      result.set(key, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return result;
}

function recordName(record: GpRecord): string {
  return record.OBJECT_NAME ?? "";
}

function recordSatnum(record: GpRecord): string | undefined {
  const id = (record as OmmRecord).NORAD_CAT_ID;
  return id === undefined || id === null ? undefined : String(id);
}

function applySelect(records: OmmRecord[], select: GroupDefinition["select"]): OmmRecord[] {
  if (!select) {
    return records;
  }
  const noradIds = new Set((select.noradIds ?? []).map((id) => String(id)));
  const names = new Set(select.names ?? []);
  const pattern = select.namePattern ? new RegExp(select.namePattern) : undefined;
  return records.filter((record) => {
    if (noradIds.size > 0) {
      const satnum = recordSatnum(record);
      if (satnum !== undefined && noradIds.has(satnum)) {
        return true;
      }
    }
    if (names.size > 0 && names.has(recordName(record))) {
      return true;
    }
    if (pattern && pattern.test(recordName(record))) {
      return true;
    }
    return false;
  });
}

function applyRename(records: GpRecord[], rename: GroupDefinition["rename"]): GpRecord[] {
  if (!rename) {
    return records;
  }
  return records.map((record) => {
    const current = record.OBJECT_NAME;
    if (current !== undefined && current in rename) {
      return { ...record, OBJECT_NAME: rename[current]! };
    }
    return record;
  });
}

// Topologically order group definitions by their `include` edges so that
// included groups are always evaluated before their consumers. Assumes the
// graph is acyclic and all include targets exist (the generator validates
// both), but is written to terminate even if that guarantee is somehow
// violated.
function topoOrder(defs: GroupDefinition[]): GroupDefinition[] {
  const byName = new Map(defs.map((def) => [def.name, def]));
  const ordered: GroupDefinition[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (def: GroupDefinition): void => {
    const status = state.get(def.name);
    if (status === "done" || status === "visiting") {
      return;
    }
    state.set(def.name, "visiting");
    for (const dep of def.include ?? []) {
      const depDef = byName.get(dep);
      if (depDef) {
        visit(depDef);
      }
    }
    state.set(def.name, "done");
    ordered.push(def);
  };
  for (const def of defs) {
    visit(def);
  }
  return ordered;
}

// Evaluate every group into its final record list. A group whose source failed
// (or whose included group failed) evaluates to an Error value rather than
// throwing.
export function evaluateGroups(defs: GroupDefinition[], recordsBySource: RecordsBySource): Map<string, GpRecord[] | Error> {
  const results = new Map<string, GpRecord[] | Error>();
  for (const def of topoOrder(defs)) {
    try {
      // Concat source records (propagating any source failure).
      let records: GpRecord[] = [];
      for (const spec of def.sources ?? []) {
        const sourceRecords = recordsBySource.get(sourceKey(spec));
        if (sourceRecords === undefined) {
          throw new Error(`source ${sourceKey(spec)} was not fetched`);
        }
        if (sourceRecords instanceof Error) {
          throw new Error(`source ${sourceKey(spec)} failed: ${sourceRecords.message}`);
        }
        records = records.concat(sourceRecords);
      }

      // select (only meaningful for OMM records) -> rename.
      records = applyRename(applySelect(records as OmmRecord[], def.select), def.rename);

      // Prepend included groups' outputs (evaluated first via topo order).
      const included: GpRecord[] = [];
      for (const dep of def.include ?? []) {
        const depResult = results.get(dep);
        if (depResult === undefined) {
          throw new Error(`included group ${dep} was not evaluated`);
        }
        if (depResult instanceof Error) {
          throw new Error(`included group ${dep} failed: ${depResult.message}`);
        }
        included.push(...depResult);
      }

      // Final order: includes, then this group's own records, then extras.
      const extras = def.extraRecords ?? [];
      results.set(def.name, [...included, ...records, ...extras]);
    } catch (err) {
      results.set(def.name, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return results;
}

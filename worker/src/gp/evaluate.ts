// Pure, runtime-agnostic group evaluator. NO Cloudflare APIs here so it can be
// unit-tested and reused by the static generator via node type stripping.

import type { GpRecord, GroupDefinition, GroupsIndex, GroupStatus, OmmRecord, SatelliteSpec, SourceSpec } from "./types.ts";

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

function selectMatches(record: OmmRecord, select: GroupDefinition["select"]): boolean {
  if (!select) {
    return false;
  }
  const noradIds = new Set((select.noradIds ?? []).map((id) => String(id)));
  if (noradIds.size > 0) {
    const satnum = recordSatnum(record);
    if (satnum !== undefined && noradIds.has(satnum)) {
      return true;
    }
  }
  if ((select.names ?? []).includes(recordName(record))) {
    return true;
  }
  if (select.namePattern && new RegExp(select.namePattern).test(recordName(record))) {
    return true;
  }
  return false;
}

// A satellites row matches a record by noradId (when present) or, failing that,
// by exact upstreamName. A row with neither is invalid; the generator rejects
// it, and this ignores it defensively.
function rowMatches(record: OmmRecord, row: SatelliteSpec): boolean {
  if (row.noradId !== undefined) {
    return recordSatnum(record) === String(row.noradId);
  }
  if (row.upstreamName !== undefined) {
    return recordName(record) === row.upstreamName;
  }
  return false;
}

// Result of selecting/renaming a group's own source records: the surviving
// records (with row-level renames already applied) plus any validation
// warnings the rows produced.
interface SelectResult {
  records: OmmRecord[];
  warnings: string[];
}

// Select source records via the OR-union of `satellites` rows and `select`,
// apply per-row `name` renames (precedence over the group `rename` map), then
// the group `rename` map to whatever a row did not rename. Emits warnings for
// id/name mismatches and rows whose id matched no record.
function applySelectAndRename(records: OmmRecord[], def: GroupDefinition): SelectResult {
  const rows = def.satellites ?? [];
  const warnings: string[] = [];
  const matchedByRow = rows.map(() => false);
  const out: OmmRecord[] = [];
  // With neither `satellites` rows nor a `select`, every source record passes
  // through (subject only to the group `rename` map) — the original semantics.
  const passAll = rows.length === 0 && !def.select;

  for (const record of records) {
    let matchedRow = false;
    let rowName: string | undefined;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      if (!rowMatches(record, row)) {
        continue;
      }
      matchedByRow[r] = true;
      // Validate an id-matched record against its expected upstream name.
      if (row.noradId !== undefined && row.upstreamName !== undefined && recordName(record) !== row.upstreamName) {
        warnings.push(`noradId ${row.noradId}: expected OBJECT_NAME ${JSON.stringify(row.upstreamName)}, got ${JSON.stringify(recordName(record))}`);
      }
      // First matching row with a `name` wins the rename; keep scanning only to
      // mark later rows as matched (harmless, but rare — usually one row/record).
      if (rowName === undefined && row.name !== undefined) {
        rowName = row.name;
      }
      matchedRow = true;
    }
    if (matchedRow) {
      // A row with a `name` takes absolute precedence (the group `rename` map is
      // not consulted). A row without a `name` still leaves the group `rename`
      // map as the remaining authority for this record.
      out.push(rowName !== undefined ? { ...record, OBJECT_NAME: rowName } : applyGroupRename(record, def.rename));
      continue;
    }
    if (passAll || selectMatches(record, def.select)) {
      out.push(applyGroupRename(record, def.rename));
    }
  }

  // Rows whose id matched no record: satellite gone from the group's sources.
  for (let r = 0; r < rows.length; r++) {
    if (!matchedByRow[r] && rows[r]!.noradId !== undefined) {
      warnings.push(`noradId ${rows[r]!.noradId}: matched no record in the group's sources`);
    }
  }

  return { records: out, warnings };
}

function applyGroupRename(record: OmmRecord, rename: GroupDefinition["rename"]): OmmRecord {
  const current = record.OBJECT_NAME;
  if (rename && current !== undefined && current in rename) {
    return { ...record, OBJECT_NAME: rename[current]! };
  }
  return record;
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

// A successfully evaluated group: its final record list plus any non-fatal
// validation warnings raised by its `satellites` rows. Warnings are per-group
// (own rows only — a group does not inherit its includes' warnings; those
// surface on the included group's own status).
export interface GroupResult {
  records: GpRecord[];
  warnings: string[];
}

// Evaluate every group into its final record list. A group whose source failed
// (or whose included group failed) evaluates to an Error value rather than
// throwing; a successful group evaluates to a GroupResult carrying its records
// and warnings.
export function evaluateGroups(defs: GroupDefinition[], recordsBySource: RecordsBySource): Map<string, GroupResult | Error> {
  const results = new Map<string, GroupResult | Error>();
  for (const def of topoOrder(defs)) {
    try {
      // Concat source records (propagating any source failure). Sources always
      // yield OMM records (parseOmmArray validates the shape); TLE extras and
      // includes only join after select/rename.
      let sourceRecords: OmmRecord[] = [];
      for (const spec of def.sources ?? []) {
        const fetched = recordsBySource.get(sourceKey(spec));
        if (fetched === undefined) {
          throw new Error(`source ${sourceKey(spec)} was not fetched`);
        }
        if (fetched instanceof Error) {
          throw new Error(`source ${sourceKey(spec)} failed: ${fetched.message}`);
        }
        sourceRecords = sourceRecords.concat(fetched);
      }

      const selected = applySelectAndRename(sourceRecords, def);

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
        included.push(...depResult.records);
      }

      // Final order: includes, then this group's own records, then extras.
      const extras = def.extraRecords ?? [];
      results.set(def.name, { records: [...included, ...selected.records, ...extras], warnings: selected.warnings });
    } catch (err) {
      results.set(def.name, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return results;
}

// Coerce a possibly-missing or corrupt raw index value into a valid
// GroupsIndex, falling back to an empty index.
export function coerceIndex(raw: unknown): GroupsIndex {
  if (raw && typeof raw === "object" && Array.isArray((raw as GroupsIndex).groups)) {
    return raw as GroupsIndex;
  }
  return { updated: "", groups: [] };
}

// Build the per-group status index for a refresh run. Failed groups keep the
// previous run's `updated`/`count` (their last-known-good data remains served)
// and gain lastError/lastErrorAt; successful groups report fresh values.
// Shared by the worker cron refresh and the static snapshot generator so the
// last-known-good semantics cannot diverge.
export function buildStatuses(defs: GroupDefinition[], evaluated: Map<string, GroupResult | Error>, previousIndex: GroupsIndex, now: string): GroupStatus[] {
  const previousByName = new Map(previousIndex.groups.map((status) => [status.name, status]));
  return defs.map((def) => {
    const result = evaluated.get(def.name);
    if (result === undefined || result instanceof Error) {
      const message = result instanceof Error ? result.message : "not evaluated";
      const prev = previousByName.get(def.name);
      return { name: def.name, updated: prev?.updated ?? null, count: prev?.count ?? 0, lastError: message, lastErrorAt: now };
    }
    const status: GroupStatus = { name: def.name, updated: now, count: result.records.length };
    if (result.warnings.length > 0) {
      status.warnings = result.warnings;
    }
    return status;
  });
}

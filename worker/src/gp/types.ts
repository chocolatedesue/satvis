// Shared GP (general perturbations) element-set types.
//
// IMPORTANT: This file (and everything else under worker/src/gp/) must stay
// node-type-strippable (erasable syntax only) because the static generator
// imports it with plain `node` (v24) type stripping. That means NO enums, NO
// namespaces, NO parameter properties, NO `import =` — only type-level syntax
// that erases cleanly to plain JS.

// CelesTrak OMM JSON record (GP element set). CelesTrak emits many optional
// fields; we only rely on OBJECT_NAME / NORAD_CAT_ID for selection, so the
// rest are kept as an open index signature.
export interface OmmRecord {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  OBJECT_ID?: string;
  EPOCH?: string;
  [key: string]: unknown;
}

// Escape hatch for pseudo element sets (ot-add / otc-p1) that use fake
// catalog numbers and cannot be expressed as OMM. Carried through the
// pipeline verbatim as two TLE lines.
export interface TleRecord {
  OBJECT_NAME?: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
}

export type GpRecord = OmmRecord | TleRecord;

// A single upstream source for a group. Exactly one key is present.
export type SourceSpec = { celestrak: string } | { celestrakSup: string } | { url: string };

export interface GroupSelect {
  noradIds?: (number | string)[];
  names?: string[];
  namePattern?: string;
}

export interface GroupDefinition {
  // Served at /api/gp/<name>.json — must match ^[a-zA-Z0-9_-]+$.
  name: string;
  sources?: SourceSpec[];
  select?: GroupSelect;
  // OBJECT_NAME -> new name, applied post-select.
  rename?: Record<string, string>;
  // Names of other groups whose output is prepended (evaluated first).
  include?: string[];
  // Inlined by the generator from extraRecordsFile; appended verbatim.
  extraRecords?: GpRecord[];
}

// A metadata rule matches records and attaches opaque metadata. The worker
// treats `metadata` as opaque JSON and only merges rule arrays; the frontend
// interprets the payload.
export interface MetadataRule {
  match: {
    satnums?: string[];
    names?: string[];
    namePattern?: string;
  };
  metadata: Record<string, unknown>;
}

export interface GroupsConfig {
  groups: GroupDefinition[];
  metadata?: MetadataRule[];
}

// Per-group status entry stored in the KV index (gp:index).
export interface GroupStatus {
  name: string;
  updated: string | null;
  count: number;
  lastError?: string;
  lastErrorAt?: string;
}

export interface GroupsIndex {
  updated: string;
  groups: GroupStatus[];
}

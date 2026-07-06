// GP (general perturbations) element-set parsing and satrec creation.
//
// This module is the single "format seam" between the upstream element-set
// payloads (CelesTrak OMM JSON, worker `TleRecord` JSON, or legacy TLE text)
// and the rest of the frontend. Everything downstream works with `GpRecord`
// values; only `createSatrec` bridges to satellite.js.
//
// IMPORTANT: this module (and the modules that depend on it — SatelliteCatalog,
// Orbit) must stay Cesium-free so node-env vitest can exercise it.

import { json2satrec, twoline2satrec, type OMMJsonObject, type SatRec } from "satellite.js";

export type GpRecord = { kind: "omm"; omm: OMMJsonObject } | { kind: "tle"; name: string; line1: string; line2: string };

// Worker `TleRecord` (see worker/src/gp/types.ts) — pseudo element sets carried
// verbatim as two TLE lines.
interface WorkerTleRecord {
  OBJECT_NAME?: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
}

function isWorkerTleRecord(obj: unknown): obj is WorkerTleRecord {
  return (
    typeof obj === "object" && obj !== null && typeof (obj as Record<string, unknown>).TLE_LINE1 === "string" && typeof (obj as Record<string, unknown>).TLE_LINE2 === "string"
  );
}

// Satnum lives in columns 3-8 (1-indexed) of a TLE line.
function satnumFromTleLine(line: string): string {
  return line.substring(2, 7).trim();
}

// Strip a leading "0 " name prefix used by some 3-line TLE feeds.
function stripNamePrefix(name: string): string {
  return name.startsWith("0 ") ? name.substring(2) : name;
}

// Normalize a satnum: strip leading zeros when the value is all-digit
// ("00005" -> "5"); keep alpha-5 designators (e.g. "E8493") untouched.
function normalizeSatnum(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return String(parseInt(trimmed, 10));
  }
  return trimmed;
}

// Parse a payload (worker JSON array or legacy TLE text) into GpRecords.
// Never throws on malformed input: bad TLE blocks are skipped with a warning.
export function parseGpPayload(text: string): GpRecord[] {
  const trimmed = text.trimStart();
  const firstChar = trimmed[0];
  if (firstChar === "[" || firstChar === "{") {
    return parseJsonPayload(text);
  }
  // A missing group served by an SPA fallback (dev/static hosts) returns the
  // index HTML with a 200 status. Detect it and bail without per-line warnings.
  if (firstChar === "<") {
    console.warn("Skipping GP payload that looks like HTML (missing group?)");
    return [];
  }
  return parseTleText(text);
}

function parseJsonPayload(text: string): GpRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.warn("Failed to parse GP JSON payload", error);
    return [];
  }
  const array = Array.isArray(parsed) ? parsed : [parsed];
  const records: GpRecord[] = [];
  for (const item of array) {
    if (isWorkerTleRecord(item)) {
      const name = item.OBJECT_NAME?.trim() || satnumFromTleLine(item.TLE_LINE1);
      records.push({ kind: "tle", name, line1: item.TLE_LINE1, line2: item.TLE_LINE2 });
    } else if (typeof item === "object" && item !== null) {
      records.push({ kind: "omm", omm: item as OMMJsonObject });
    } else {
      console.warn("Skipping unrecognized GP record", item);
    }
  }
  return records;
}

// Walk TLE text handling 3-line blocks (optionally "0 "-prefixed name),
// and bare 2-line blocks. Malformed lines are skipped with a warning.
//
// Deliberate near-duplicate of worker/scripts/generate-groups.mjs parseTleText
// with an intentionally opposite error policy: this browser path degrades
// gracefully (warn and skip), the build tool throws. Do not "unify" them.
function parseTleText(text: string): GpRecord[] {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const records: GpRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.startsWith("1 ")) {
      // Bare 2-line block (no name line).
      const line1 = line;
      const line2 = lines[i + 1] ?? "";
      if (line2.startsWith("2 ")) {
        records.push({ kind: "tle", name: satnumFromTleLine(line1), line1, line2 });
        i += 2;
      } else {
        console.warn(`Skipping malformed TLE block at line ${i}: line 2 missing or invalid`);
        i += 1;
      }
    } else {
      // Name line followed by two TLE lines.
      const line1 = lines[i + 1] ?? "";
      const line2 = lines[i + 2] ?? "";
      if (line1.startsWith("1 ") && line2.startsWith("2 ")) {
        records.push({ kind: "tle", name: stripNamePrefix(line.trim()), line1, line2 });
        i += 3;
      } else {
        console.warn(`Skipping malformed TLE block at line ${i}: expected name + 2 TLE lines`);
        i += 1;
      }
    }
  }
  return records;
}

export function recordName(r: GpRecord): string {
  if (r.kind === "omm") {
    return (r.omm.OBJECT_NAME ?? "").trim();
  }
  return r.name;
}

export function recordSatnum(r: GpRecord): string {
  if (r.kind === "omm") {
    return normalizeSatnum(String(r.omm.NORAD_CAT_ID ?? ""));
  }
  return normalizeSatnum(satnumFromTleLine(r.line1));
}

// The ONLY satrec creation point in the frontend. Called by Orbit.
export function createSatrec(r: GpRecord): SatRec {
  if (r.kind === "omm") {
    return json2satrec(r.omm);
  }
  return twoline2satrec(r.line1, r.line2);
}

// Build the 3 TLE lines (name, line 1, line 2) for a TLE-sourced record so the
// InfoBox can display them as today.
export function recordTleLines(r: GpRecord): string[] | undefined {
  if (r.kind === "tle") {
    return [r.name, r.line1, r.line2];
  }
  return undefined;
}

#!/usr/bin/env node
// Merge the committed core groups config with every data/custom/*/groups.json
// plugin config, inline each group's extraRecordsFile TLE text into
// extraRecords, validate, and write worker/src/config/groups.generated.json.
//
// Plain node, zero deps. With no plugin configs present this still produces a
// valid generated file from the core groups (so lint/CI stay green).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(workerDir, "..");

const coreConfigPath = path.join(workerDir, "src", "config", "groups.core.json");
const customDir = path.join(repoRoot, "data", "custom");
const outPath = path.join(workerDir, "src", "config", "groups.generated.json");

const GROUP_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Parse TLE text into TleRecord objects. Supports 3-line blocks (optional
// leading "0 " on the name line), and bare 2-line blocks (no name).
//
// Deliberate near-duplicate of src/modules/util/gp.ts parseTleText with an
// intentionally opposite error policy: this build tool fails loud (throws) so
// bad input never ships, while the browser path warns and skips. Do not
// "unify" them.
function parseTleText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
  const records = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("1 ") && i + 1 < lines.length && lines[i + 1].startsWith("2 ")) {
      // Bare 2-line block.
      records.push({ TLE_LINE1: line, TLE_LINE2: lines[i + 1] });
      i += 2;
    } else if (i + 2 < lines.length && lines[i + 1].startsWith("1 ") && lines[i + 2].startsWith("2 ")) {
      // 3-line block; strip an optional "0 " name prefix.
      const name = line.startsWith("0 ") ? line.slice(2) : line;
      records.push({ OBJECT_NAME: name, TLE_LINE1: lines[i + 1], TLE_LINE2: lines[i + 2] });
      i += 3;
    } else {
      throw new Error(`unrecognized TLE block at line ${i + 1}: ${JSON.stringify(line)}`);
    }
  }
  return records;
}

// Load and normalize one config file. `extraRecordsFile` (generator-only) is
// resolved relative to the config's directory and inlined into extraRecords.
function loadConfig(configPath) {
  const config = readJson(configPath);
  const dir = path.dirname(configPath);
  const groups = (config.groups ?? []).map((group) => {
    const { extraRecordsFile, ...rest } = group;
    if (extraRecordsFile) {
      const txtPath = path.join(dir, extraRecordsFile);
      const parsed = parseTleText(fs.readFileSync(txtPath, "utf8"));
      rest.extraRecords = [...(rest.extraRecords ?? []), ...parsed];
    }
    return rest;
  });
  return { groups, metadata: config.metadata ?? [] };
}

function discoverPluginConfigs() {
  if (!fs.existsSync(customDir)) {
    return [];
  }
  const configs = [];
  for (const entry of fs.readdirSync(customDir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(customDir, entry.name, "groups.json");
    if (fs.existsSync(candidate)) {
      configs.push(candidate);
    }
  }
  return configs;
}

// Validate a group's `satellites` rows (if any). Each row must select by
// `noradId` (number) or `upstreamName` (string); `name`/`metadata` optional
// with checked types. Throws with the group name on any violation.
function validateSatellites(group) {
  if (group.satellites === undefined) {
    return;
  }
  if (!Array.isArray(group.satellites)) {
    throw new Error(`group ${JSON.stringify(group.name)}: "satellites" must be an array`);
  }
  group.satellites.forEach((row, i) => {
    const where = `group ${JSON.stringify(group.name)} satellites[${i}]`;
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${where}: must be an object`);
    }
    if (row.noradId !== undefined && typeof row.noradId !== "number") {
      throw new Error(`${where}: "noradId" must be a number`);
    }
    if (row.upstreamName !== undefined && typeof row.upstreamName !== "string") {
      throw new Error(`${where}: "upstreamName" must be a string`);
    }
    if (row.noradId === undefined && row.upstreamName === undefined) {
      throw new Error(`${where}: must have a "noradId" or "upstreamName"`);
    }
    if (row.name !== undefined && typeof row.name !== "string") {
      throw new Error(`${where}: "name" must be a string`);
    }
    if (row.metadata !== undefined && (row.metadata === null || typeof row.metadata !== "object" || Array.isArray(row.metadata))) {
      throw new Error(`${where}: "metadata" must be an object`);
    }
  });
}

function validate(groups) {
  const names = new Set();
  for (const group of groups) {
    if (typeof group.name !== "string" || !GROUP_NAME_RE.test(group.name)) {
      throw new Error(`invalid group name ${JSON.stringify(group.name)} (must match ${GROUP_NAME_RE})`);
    }
    if (names.has(group.name)) {
      throw new Error(`duplicate group name ${JSON.stringify(group.name)}`);
    }
    names.add(group.name);
    validateSatellites(group);
  }
  // include targets must exist.
  for (const group of groups) {
    for (const dep of group.include ?? []) {
      if (!names.has(dep)) {
        throw new Error(`group ${JSON.stringify(group.name)} includes unknown group ${JSON.stringify(dep)}`);
      }
    }
  }
  // no include cycles (DFS).
  const byName = new Map(groups.map((g) => [g.name, g]));
  const state = new Map();
  const visit = (name, stack) => {
    if (state.get(name) === "done") {
      return;
    }
    if (state.get(name) === "visiting") {
      throw new Error(`include cycle detected: ${[...stack, name].join(" -> ")}`);
    }
    state.set(name, "visiting");
    for (const dep of byName.get(name)?.include ?? []) {
      visit(dep, [...stack, name]);
    }
    state.set(name, "done");
  };
  for (const group of groups) {
    visit(group.name, []);
  }
}

// Lift each satellites-row `metadata` into a MetadataRule. The frontend matches
// rules against the SERVED record — its satnum and its displayed name — so:
//   - a row with a noradId keys on { satnums: [String(noradId)] } (the satnum
//     is stable across renames, so this is the most robust match);
//   - a name-only row keys on { names: [row.name ?? row.upstreamName] }, i.e.
//     the served name (the renamed one if `name` is set, else the upstream
//     name that passes through unchanged) — never the raw upstreamName, which
//     the frontend never sees once a row renames the record.
function liftSatelliteMetadata(groups) {
  const rules = [];
  for (const group of groups) {
    for (const row of group.satellites ?? []) {
      if (row.metadata === undefined) {
        continue;
      }
      const match = row.noradId !== undefined ? { satnums: [String(row.noradId)] } : { names: [row.name ?? row.upstreamName] };
      rules.push({ match, metadata: row.metadata });
    }
  }
  return rules;
}

function main() {
  const core = loadConfig(coreConfigPath);
  const groups = [...core.groups];
  const explicitMetadata = [...core.metadata];

  for (const configPath of discoverPluginConfigs()) {
    const plugin = loadConfig(configPath);
    groups.push(...plugin.groups);
    explicitMetadata.push(...plugin.metadata);
  }

  validate(groups);

  // Lifted rules come BEFORE explicit rules in the merged array. The frontend
  // shallow-merges matching rules in array order (later wins field-wise), so
  // placing explicit rules last lets them override lifted per-satellite values.
  const metadata = [...liftSatelliteMetadata(groups), ...explicitMetadata];

  const generated = { groups, metadata };
  fs.writeFileSync(outPath, `${JSON.stringify(generated, null, 2)}\n`);
  process.stdout.write(`Wrote ${path.relative(repoRoot, outPath)} (${groups.length} groups, ${metadata.length} metadata rules)\n`);
}

main();

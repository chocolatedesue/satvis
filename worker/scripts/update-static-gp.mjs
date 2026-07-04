#!/usr/bin/env node
// Worker-less static snapshot generator. Runs the SAME fetch + evaluate flow
// as the cron refresh (importing the runtime evaluator directly via node's
// built-in TS type stripping, node >= 24) and writes a static OMM-JSON
// snapshot into data/gp/ at the repo root:
//   data/gp/<group>.json  — the evaluated records for each successful group
//   data/gp/index.json    — GroupsIndex shape (mirrors gp:index)
//   data/gp/metadata.json — merged metadata rules
//
// `pnpm update-gp` chains generate-groups first so the generated config is
// fresh. Output is gitignored.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { evaluateGroups, fetchSources } from "../src/gp/evaluate.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(workerDir, "..");

const configPath = path.join(workerDir, "src", "config", "groups.generated.json");
const outDir = path.join(repoRoot, "data", "gp");

// Read the existing index, tolerating absence or corruption. Mirrors the
// worker's readIndex so we can carry forward last-known-good status.
export function readIndex(indexPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.groups)) {
      return raw;
    }
  } catch {
    // Missing or corrupt index: start from empty.
  }
  return { updated: "", groups: [] };
}

// Build the new index. Failed groups keep the previous run's `updated`/`count`
// (their data/gp/<group>.json is still on disk and served) and gain
// lastError/lastErrorAt; successful groups overwrite. Mirrors refreshAll.
export function buildStatuses(defs, evaluated, previousIndex, now, onStatus) {
  const previousByName = new Map(previousIndex.groups.map((status) => [status.name, status]));
  const statuses = [];
  for (const def of defs) {
    const result = evaluated.get(def.name);
    const prev = previousByName.get(def.name);
    if (result === undefined || result instanceof Error) {
      const message = result instanceof Error ? result.message : "not evaluated";
      statuses.push({
        name: def.name,
        updated: prev?.updated ?? null,
        count: prev?.count ?? 0,
        lastError: message,
        lastErrorAt: now,
      });
      onStatus?.({ name: def.name, ok: false, message });
      continue;
    }
    statuses.push({ name: def.name, updated: now, count: result.length });
    onStatus?.({ name: def.name, ok: true, count: result.length });
  }
  return statuses;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const defs = config.groups;

  process.stdout.write(`Fetching sources for ${defs.length} groups...\n`);
  const recordsBySource = await fetchSources(defs, (url, init) => fetch(url, init));
  const evaluated = evaluateGroups(defs, recordsBySource);

  fs.mkdirSync(outDir, { recursive: true });
  const now = new Date().toISOString();
  const indexPath = path.join(outDir, "index.json");
  const previousIndex = readIndex(indexPath);

  // Write successful groups; failed groups keep their existing file on disk.
  for (const def of defs) {
    const result = evaluated.get(def.name);
    if (result !== undefined && !(result instanceof Error)) {
      fs.writeFileSync(path.join(outDir, `${def.name}.json`), `${JSON.stringify(result)}\n`);
    }
  }

  const statuses = buildStatuses(defs, evaluated, previousIndex, now, (s) => {
    if (s.ok) {
      process.stdout.write(`  ${s.name}: ${s.count} records\n`);
    } else {
      process.stdout.write(`  ${s.name}: FAILED (${s.message}) — keeping last-known-good\n`);
    }
  });

  const index = { updated: now, groups: statuses };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "metadata.json"), `${JSON.stringify(config.metadata ?? [], null, 2)}\n`);

  process.stdout.write(`Wrote ${path.relative(repoRoot, outDir)}/ (${statuses.filter((s) => s.updated).length}/${defs.length} groups)\n`);
}

// Only run when invoked directly (not when imported for testing the helpers).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

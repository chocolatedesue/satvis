#!/usr/bin/env node
// Worker-less static snapshot generator. Runs the SAME refresh pipeline as
// the cron (importing the runtime refresh directly via node's built-in TS
// type stripping, node >= 24) against a disk-backed GroupStore adapter,
// writing a static OMM-JSON snapshot into data/gp/ at the repo root:
//   data/gp/<group>.json  — the evaluated, enriched records for each successful group
//   data/gp/index.json    — GroupsIndex shape (mirrors gp:index)
//
// `pnpm update-gp` chains generate-groups first so the generated config is
// fresh. Output is gitignored.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { coerceIndex } from "../src/gp/evaluate.ts";
import { refreshGroups } from "../src/gp/refresh.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(workerDir, "..");

const configPath = path.join(workerDir, "src", "config", "satvis.generated.json");
const outDir = path.join(repoRoot, "data", "gp");
const satcatPath = path.join(workerDir, ".cache", "satcat.json");

// Disk adapter for the GroupStore seam (see worker/src/gp/store.ts). Failed
// groups get no write, so their last-known-good file stays on disk — the same
// contract the KV adapter provides.
//
// The SATCAT snapshot is the one value here that is an input as well as an
// output: the fetch is conditional, so a 304 leaves the previous run's rows as
// the enrichment source. Deleting it costs one full 6.7 MB download, nothing
// more.
//
// It lives outside data/ on purpose. Everything under data/ is copied into the
// build (see viteStaticCopy in vite.config.ts), and this is a build-time cache
// the app never fetches — the facts it holds reach the browser already attached
// to the records in data/gp/<group>.json.
function diskGroupStore(dir, cachePath) {
  const indexPath = path.join(dir, "index.json");
  return {
    // Read the existing index (tolerating absence or corruption) so
    // buildStatuses can carry forward last-known-good status for failed groups.
    async readIndex() {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      } catch {
        // Missing or corrupt index: start from empty.
      }
      return coerceIndex(raw);
    },
    async writeGroup(name, records) {
      fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(records)}\n`);
    },
    async writeIndex(index) {
      fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    },
    async readSatcat() {
      try {
        return JSON.parse(fs.readFileSync(cachePath, "utf8"));
      } catch {
        // Missing or corrupt: this run downloads the catalog in full.
        return undefined;
      }
    },
    async writeSatcat(snapshot) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, `${JSON.stringify(snapshot)}\n`);
    },
  };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const defs = config.groups;

  fs.mkdirSync(outDir, { recursive: true });
  const report = await refreshGroups(config, diskGroupStore(outDir, satcatPath), (url, init) => fetch(url, init));

  for (const s of report.index.groups) {
    if (s.lastError) {
      process.stdout.write(`  ${s.name}: FAILED (${s.lastError}) — keeping last-known-good\n`);
    } else {
      process.stdout.write(`  ${s.name}: ${s.count} records\n`);
    }
    for (const warning of s.warnings ?? []) {
      process.stdout.write(`    WARNING: ${warning}\n`);
    }
  }

  const satcat = report.index.satcat;
  if (satcat) {
    process.stdout.write(
      satcat.lastError ? `  satcat: FAILED (${satcat.lastError}) — kept ${satcat.count} stored rows\n` : `  satcat: ${satcat.count} rows (fetched ${satcat.updated})\n`,
    );
  }

  process.stdout.write(`Wrote ${path.relative(repoRoot, outDir)}/ (${report.written}/${defs.length} groups)\n`);
}

await main();

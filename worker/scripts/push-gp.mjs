#!/usr/bin/env node
// Off-Worker downloader for the GP pipeline. Runs the SAME download logic as the
// cron (importing fetchSources directly via node's built-in TS type stripping,
// node >= 24) from THIS machine's IP, then POSTs the raw payloads to the
// Worker's /api/ingest, which runs the normal evaluate/enrich/store pass on them.
//
// Exists because CelesTrak firewalls Cloudflare's shared Worker egress: the
// cron's own fetches come back as HTTP 522 on every source while the same URLs
// answer fine from anywhere else. Only the download moves — the Worker still
// owns the config, the evaluation and KV.
//
// Run it from a host CelesTrak is not blocking (a CI runner, a VPS, a laptop).
// One run pulls ~7 MB against CelesTrak's 250 MB/day per-IP budget, so keep the
// cadence at or above the cron's 6 h.
//
// Usage:
//   SATVIS_REFRESH_TOKEN=<token> pnpm --filter satvis-worker push-gp
//   SATVIS_INGEST_URL=http://localhost:8080/api/ingest SATVIS_REFRESH_TOKEN=... node scripts/push-gp.mjs
//
// Exits non-zero when the POST fails or when the run wrote no group at all.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchSources } from "../src/gp/evaluate.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");

const configPath = path.join(workerDir, "src", "config", "satvis.generated.json");
const ingestUrl = process.env.SATVIS_INGEST_URL ?? "https://satvis.space/api/ingest";
const token = process.env.SATVIS_REFRESH_TOKEN;

function fail(message) {
  process.stderr.write(`push-gp: ${message}\n`);
  process.exit(1);
}

async function main() {
  if (!token) {
    fail("SATVIS_REFRESH_TOKEN is not set (same value as the Worker's REFRESH_TOKEN secret)");
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const fetched = await fetchSources(config.groups, (url, init) => fetch(url, init));

  // Successful sources travel as their re-serialized record array rather than the
  // original bytes: fetchSources already parsed and validated them, and it does not
  // keep the raw body. The Worker re-parses and re-validates what it receives, so a
  // payload that got mangled in transit still fails closed there.
  //
  // Failures travel as their message so the Worker records the same lastError it
  // would have recorded itself, and that group keeps its last-known-good value.
  const bundle = {
    fetchedAt: new Date().toISOString(),
    sources: fetched.map((source) =>
      source.records === undefined
        ? { key: source.key, url: source.url, status: source.status, error: source.error ?? "fetch failed" }
        : { key: source.key, url: source.url, status: source.status, body: JSON.stringify(source.records) },
    ),
  };

  const ok = bundle.sources.filter((source) => source.body !== undefined).length;
  const body = JSON.stringify(bundle);
  process.stdout.write(`push-gp: POST ${ingestUrl} — ${ok}/${bundle.sources.length} sources downloaded, ${body.length} bytes\n`);

  let res;
  try {
    res = await fetch(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    });
  } catch (err) {
    fail(`POST failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    fail(`ingest returned HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const report = JSON.parse(text);
  for (const status of report.groups) {
    if (status.lastError) {
      process.stdout.write(`  ${status.name}: FAILED (${status.lastError}) — keeping last-known-good\n`);
    } else {
      process.stdout.write(`  ${status.name}: ${status.count} records\n`);
    }
    for (const warning of status.warnings ?? []) {
      process.stdout.write(`    WARNING: ${warning}\n`);
    }
  }
  process.stdout.write(`push-gp: ingested in ${report.durationMs}ms — ${report.written} groups written, ${report.skipped} skipped/failed\n`);

  // A run that wrote nothing accomplished nothing — surface it to CI. Partial
  // failures stay green on purpose: those groups keep serving last-known-good,
  // and /api/groups.json already carries their lastError for monitoring.
  if (report.written === 0) {
    fail("no group was written — every source failed");
  }
}

await main();

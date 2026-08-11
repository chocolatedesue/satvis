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
// One run pulls ~7 MB of GP data, so keep the cadence at or above the cron's 6 h
// — CelesTrak asks for one download per update.
//
// It also pulls the SATCAT (~6.7 MB) for satellite-table enrichment, but
// conditionally: the Worker's stored ETag comes back from /api/groups.json and
// goes out as If-None-Match, so the usual run costs a 304 with no body. SATCAT
// only updates once or twice a day, well under this cadence.
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
import { SATCAT_URL } from "../src/gp/satcat.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");

const configPath = path.join(workerDir, "src", "config", "satvis.generated.json");
const ingestUrl = process.env.SATVIS_INGEST_URL ?? "https://satvis.space/api/ingest";
const token = process.env.SATVIS_REFRESH_TOKEN;
// Same origin as the ingest endpoint: the pre-flight reads the SATCAT validator
// the Worker stored, so this download can be conditional (see downloadSatcat).
const groupsUrl = new URL("/api/groups.json", ingestUrl).toString();

function fail(message) {
  process.stderr.write(`push-gp: ${message}\n`);
  process.exit(1);
}

// The ETag of the SATCAT body the Worker currently holds, or undefined when it
// holds none (or is unreachable — in which case we simply download in full).
async function storedSatcatValidator() {
  try {
    const res = await fetch(groupsUrl);
    if (!res.ok) {
      return undefined;
    }
    const index = await res.json();
    return index?.satcat?.validator ?? undefined;
  } catch {
    return undefined;
  }
}

// Download the SATCAT conditionally and shape it as an ingest source.
//
// CelesTrak asks for one download per update and SATCAT updates once or twice a
// day, against our 6 h cadence — so the usual outcome here is a 304 with no body,
// which the Worker reads as "keep the stored snapshot". The full body only
// travels when the catalog actually changed.
//
// Unlike a group source this is posted as the raw upstream bytes rather than
// re-serialized records: the Worker re-parses and re-validates them, so a body
// mangled in transit still fails closed there — and it keeps one parser for one
// format instead of a second shape that only exists in the bundle.
async function downloadSatcat() {
  const validator = await storedSatcatValidator();
  const headers = { "User-Agent": "satvis.space (https://github.com/Flowm/satvis)" };
  if (validator !== undefined) {
    headers["If-None-Match"] = validator;
  }
  const started = Date.now();
  try {
    const res = await fetch(SATCAT_URL, { headers });
    const ms = Date.now() - started;
    if (res.status === 304) {
      process.stdout.write(`push-gp: satcat 304 not modified (${ms}ms) — worker keeps its stored snapshot\n`);
      return { key: "satcat", url: SATCAT_URL, status: 304 };
    }
    if (!res.ok) {
      process.stdout.write(`push-gp: satcat HTTP ${res.status} (${ms}ms)\n`);
      return { key: "satcat", url: SATCAT_URL, status: res.status, error: `HTTP ${res.status}` };
    }
    const body = await res.text();
    process.stdout.write(`push-gp: satcat HTTP 200 — ${body.length} bytes in ${ms}ms\n`);
    return { key: "satcat", url: SATCAT_URL, status: 200, body, validator: res.headers.get("etag") ?? undefined };
  } catch (err) {
    return { key: "satcat", url: SATCAT_URL, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  if (!token) {
    fail("SATVIS_REFRESH_TOKEN is not set (same value as the Worker's REFRESH_TOKEN secret)");
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const fetched = await fetchSources(config.groups, (url, init) => fetch(url, init));
  const satcat = await downloadSatcat();

  // Successful sources travel as their re-serialized record array rather than the
  // original bytes: fetchSources already parsed and validated them, and it does not
  // keep the raw body. The Worker re-parses and re-validates what it receives, so a
  // payload that got mangled in transit still fails closed there.
  //
  // Failures travel as their message so the Worker records the same lastError it
  // would have recorded itself, and that group keeps its last-known-good value.
  const bundle = {
    fetchedAt: new Date().toISOString(),
    sources: [
      ...fetched.map((source) =>
        source.records === undefined
          ? { key: source.key, url: source.url, status: source.status, error: source.error ?? "fetch failed" }
          : { key: source.key, url: source.url, status: source.status, body: JSON.stringify(source.records) },
      ),
      satcat,
    ],
  };

  // SATCAT is not counted: a 304 is a success that carries no body, and a SATCAT
  // failure must not read as a group failure — it costs enrichment freshness and
  // nothing else.
  const ok = fetched.filter((source) => source.records !== undefined).length;
  const body = JSON.stringify(bundle);
  process.stdout.write(`push-gp: POST ${ingestUrl} — ${ok}/${fetched.length} sources downloaded (+satcat), ${body.length} bytes\n`);

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
  if (report.satcat) {
    const { count, updated, lastError } = report.satcat;
    process.stdout.write(lastError ? `  satcat: FAILED (${lastError}) — keeping ${count} stored rows\n` : `  satcat: ${count} rows (fetched ${updated})\n`);
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

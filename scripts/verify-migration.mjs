// Headless-Chromium check for the naive KV-cache migration overlay, over CDP with
// no puppeteer — same approach as scripts/verify-orbit-lab.mjs. Drives a *built*
// deployment: opens the demo, asserts the four overlay entities exist, then winds
// the clock forward until the model actually migrates the workload and the packet
// is in flight.
//
//   pnpm build && (cd dist && python3 -m http.server 8791) &
//   node scripts/verify-migration.mjs http://127.0.0.1:8791 /tmp/mig-out

/* eslint-disable no-await-in-loop -- polling a live browser is sequential. */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:8791";
const OUT = process.argv[3] ?? "/tmp/satvis-migration-verify";
const PORT = 9334;
mkdirSync(OUT, { recursive: true });

const chromium = spawn(
  "/usr/bin/chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--hide-scrollbars",
    ...(process.env.VERIFY_PROXY ? [`--proxy-server=${process.env.VERIFY_PROXY}`, "--proxy-bypass-list=<-loopback>"] : []),
    "--window-size=1440,900",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(`${tmpdir()}/satvis-mig-`)}`,
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let chromeLog = "";
chromium.stderr.on("data", (chunk) => (chromeLog += chunk));

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((entry) => entry.type === "page");
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`chromium never opened a debug target\n${chromeLog}`);
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
});

function send(method, params = {}) {
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(`${expression}\n  threw ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

async function until(expression, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${expression}`);
    await sleep(250);
  }
}

const checks = [];
function record(name, actual, expectation) {
  const ok = expectation(actual);
  checks.push({ name, actual, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(actual)}`);
}

await send("Page.enable");
await send("Runtime.enable");

await send("Page.navigate", { url: `${BASE}/?tags=&elements=Point,Illumination%20arc&time=2026-01-01T00:00` });
await until("document.querySelectorAll('#toolbarLeft .toolbarButtons button').length >= 7", "the toolbar");
await until("!!document.querySelector('canvas')", "the Cesium canvas");
await sleep(6000);

// Open the orbit-lab panel (fourth toolbar button, as in the orbit-lab check).
await evaluate("document.querySelectorAll('#toolbarLeft .toolbarButtons button')[3].click()");
await until("!!document.querySelector('.orbitLab')", "the orbit lab panel");

// One click: the migration demo.
await evaluate("[...document.querySelectorAll('.orbitLab__button')].find((b) => /KV-cache migration demo/.test(b.textContent)).click()");
await until("/mig=true/.test(window.location.search)", "the migration flag in the url");

record(
  "the demo also sets up the two-orbit scene it migrates across",
  await evaluate("({ walker: new URLSearchParams(location.search).get('walker'), paint: new URLSearchParams(location.search).get('paint'), camera: window.cc.cameraMode })"),
  (s) => s.walker === "53:20/2/1@550~180" && s.paint === "illumination" && s.camera === "Inertial",
);

await until("window.cc.sats.activeSatellites.length >= 2", "the demo satellites to build", 60_000);
await until("window.cc.migrationStatus && window.cc.migrationStatus.active === true", "the overlay to go live", 30_000);

record("the demo turns the migration overlay on", await evaluate("window.cc.migrationStatus?.active"), (v) => v === true);
record("the two-orbit scene reaches its twenty satellites", await evaluate("window.cc.sats.activeSatellites.length"), (v) => v === 20);

record(
  "the four overlay entities are on the globe",
  await evaluate("window.cc.viewer.entities.values.map((e) => e.name).filter((n) => /^Migration|^Migrating/.test(n)).sort()"),
  (names) => ["Migrating KV cache", "Migration host", "Migration link", "Migration target"].every((n) => names.includes(n)),
);

record("the status readout reports a valid phase", await evaluate("window.cc.migrationStatus?.phase"), (p) => ["holding", "migrating", "stranded"].includes(p));

// Wind the clock forward hard so a host crosses into shadow within a few wall
// seconds instead of a real orbit, and watch the model migrate.
await evaluate("(() => { window.cc.viewer.clock.multiplier = 4000; window.cc.viewer.clock.shouldAnimate = true; return true; })()");

let sawMigrating = false;
let maxMigrations = 0;
const hosts = new Set();
const deadline = Date.now() + 40_000;
while (Date.now() < deadline) {
  const status = await evaluate("window.cc.migrationStatus");
  if (status?.phase === "migrating") sawMigrating = true;
  if (typeof status?.migrations === "number") maxMigrations = Math.max(maxMigrations, status.migrations);
  if (status?.hostName) hosts.add(status.hostName);
  if (sawMigrating && maxMigrations >= 1) break;
  await sleep(400);
}

record("a migration is observed in flight (packet moving over the ISL)", sawMigrating, (v) => v === true);
record("at least one migration completes (workload lands on a new host)", maxMigrations, (v) => v >= 1);
record("the workload visits more than one host as sunlight moves", hosts.size, (v) => v >= 2);

const transfer = await evaluate("(() => { const s = window.cc.migrationStatus; return s ? { linkKm: s.linkKm, transferSeconds: s.transferSeconds, kv: s.kvGigabytes, isl: s.islGbps } : null; })()");
console.log("last transfer readout:", JSON.stringify(transfer));

// Screenshot for the record.
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}/migration.png`, Buffer.from(shot.data, "base64"));
writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, transfer, maxMigrations, hostsVisited: [...hosts] }, null, 2));

const failed = checks.filter((c) => !c.ok);
if (consoleErrors.length) console.log(`\nconsole errors (${consoleErrors.length}):\n` + consoleErrors.slice(0, 10).join("\n"));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; screenshot + report in ${OUT}`);
chromium.kill("SIGKILL");
process.exit(failed.length === 0 ? 0 : 1);

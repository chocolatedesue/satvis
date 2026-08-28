// Headless-Chromium check for the naive KV-cache migration overlay, over CDP with
// no puppeteer — same approach as scripts/verify-orbit-lab.mjs. Drives a *built*
// deployment: opens the demo, asserts the pipeline is placed one stage per
// satellite with all its entities, then winds the clock forward until the model
// actually migrates stages, the pipeline is seen stalled, and the ledger has
// accounted served and stalled time.
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

/** The pipeline length the demo button leaves in place (config/migration DEFAULT_PIPELINE_STAGES). */
const STAGES = 4;

// The overlay goes `active` as soon as it is switched on, but it cannot place the
// pipeline until the satellites have both a sampled position and an illumination
// state. Wait for the placement rather than racing it.
await until(`window.cc.migrationStatus?.stages?.length === ${STAGES}`, "the pipeline to be placed", 60_000);

record("the pipeline is cut into four stages", await evaluate("window.cc.migrationStatus?.stages?.length"), (v) => v === STAGES);

record(
  "every stage sits on its own satellite — no two stages co-located",
  await evaluate("(() => { const hosts = (window.cc.migrationStatus?.stages ?? []).map((s) => s.hostName); return { hosts, distinct: new Set(hosts).size }; })()"),
  (s) => s.hosts.length === STAGES && s.hosts.every((h) => typeof h === "string") && s.distinct === STAGES,
);

record(
  "all four overlay entities exist for every stage",
  await evaluate("window.cc.viewer.entities.values.map((e) => e.name).filter((n) => /^Migration|^Migrating/.test(n)).length"),
  (n) => n === STAGES * 4,
);

record(
  "each stage's entities are named after it",
  await evaluate(
    "['Migration host S1','Migration link S1','Migration target S1','Migrating KV cache S1','Migration host S4','Migrating KV cache S4'].filter((n) => window.cc.viewer.entities.values.some((e) => e.name === n))",
  ),
  (found) => found.length === 6,
);

record("the status readout reports a valid phase", await evaluate("window.cc.migrationStatus?.phase"), (p) => ["holding", "migrating", "stranded"].includes(p));

record(
  "the pipeline reports whether it is serving, and how many stages have power",
  await evaluate("(() => { const s = window.cc.migrationStatus; return { serving: s?.serving, powered: s?.poweredStages, stages: s?.stages.length }; })()"),
  (s) => typeof s.serving === "boolean" && Number.isInteger(s.powered) && s.powered <= s.stages,
);

record(
  "serving is exactly the conjunction: every stage powered and none in flight",
  await evaluate(
    "(() => { const s = window.cc.migrationStatus; const all = s.stages.every((st) => st.powered && st.phase !== 'migrating'); return { serving: s.serving, all }; })()",
  ),
  (s) => s.serving === s.all,
);

// Wind the clock forward hard so hosts cross into shadow within a few wall seconds
// instead of a real orbit, and watch the model migrate.
await evaluate("(() => { window.cc.viewer.clock.multiplier = 4000; window.cc.viewer.clock.shouldAnimate = true; return true; })()");

let sawMigrating = false;
let sawStalled = false;
let sawAllPowered = false;
let maxMigrations = 0;
let logLength = 0;
const hosts = new Set();
const stagesThatMoved = new Set();
// Run until the pipeline has been seen in *both* states, not for a fixed window: the
// ledger's fraction is only meaningful once some time has been attributed each way,
// and how soon that happens depends on where the stages were placed.
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const status = await evaluate("window.cc.migrationStatus");
  if (status?.phase === "migrating") sawMigrating = true;
  if (status?.poweredStages === status?.stages?.length) sawAllPowered = true;
  else sawStalled = true;
  if (typeof status?.migrations === "number") maxMigrations = Math.max(maxMigrations, status.migrations);
  if (Array.isArray(status?.log)) {
    logLength = Math.max(logLength, status.log.length);
    for (const event of status.log) stagesThatMoved.add(event.stage);
  }
  for (const stage of status?.stages ?? []) if (stage.hostName) hosts.add(stage.hostName);
  if (sawMigrating && sawStalled && sawAllPowered && maxMigrations >= 1 && logLength >= 1) break;
  await sleep(400);
}

record("a migration is observed in flight (packet moving over the ISL)", sawMigrating, (v) => v === true);
record("migrations complete (stages land on new hosts)", maxMigrations, (v) => v >= 1);
record("the stages visit more satellites than the pipeline is long", hosts.size, (v) => v > STAGES);
record("the pipeline is seen with every stage powered", sawAllPowered, (v) => v === true);
record("the pipeline is seen stalled — the all-stages-at-once condition does fail", sawStalled, (v) => v === true);
record("the migration log records completed migrations", logLength, (v) => v >= 1);

const readout = await evaluate(
  "(() => { const s = window.cc.migrationStatus; return s ? { ledger: s.ledger, allPoweredFraction: s.allPoweredFraction, linkKm: s.linkKm, transferSeconds: s.transferSeconds, kv: s.kvGigabytes, isl: s.islGbps, log: s.log } : null; })()",
);

record(
  "the ledger splits simulated time by whether every stage had power",
  { allPowered: readout?.ledger?.allPoweredSeconds, stalled: readout?.ledger?.stalledSeconds, fraction: readout?.allPoweredFraction },
  (l) => Number.isFinite(l.allPowered) && Number.isFinite(l.stalled) && l.allPowered + l.stalled > 0 && l.fraction > 0 && l.fraction < 1,
);

record(
  "the ledger's moved bytes and link time match the migration count",
  { migrations: readout?.ledger?.migrations, gb: readout?.ledger?.gigabytesMoved, seconds: readout?.ledger?.transferSeconds },
  (l) => l.migrations >= 1 && l.gb === l.migrations * 2 && l.seconds > l.migrations * 0.16,
);

record(
  "the pipeline's ceiling is well below a single satellite's lit fraction",
  readout?.allPoweredFraction,
  // Four stages need four coincidences; a single satellite is lit roughly half the
  // time, so the conjunction has to land clearly under that or the model is wrong.
  (f) => f < 0.5,
);

record(
  "every link respects line of sight — no hop through the Earth",
  (readout?.log ?? []).map((event) => Math.round(event.linkKm)),
  // Two satellites at 550 km can see each other only out to 2*sqrt(6921² - 6451²) ≈
  // 5014 km, taking the 80 km atmospheric margin. Anything longer was drawn through
  // the planet, which is what the line-of-sight constraint exists to stop.
  (links) => links.length > 0 && links.every((km) => km < 5050),
);

console.log("ledger:", JSON.stringify(readout?.ledger), "all-stages-powered fraction:", readout?.allPoweredFraction);
console.log("log (newest first):", JSON.stringify(readout?.log?.slice(0, 3)));

// Screenshot for the record.
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}/migration.png`, Buffer.from(shot.data, "base64"));
writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, readout, maxMigrations, hostsVisited: [...hosts], stagesThatMoved: [...stagesThatMoved] }, null, 2));

const failed = checks.filter((c) => !c.ok);
if (consoleErrors.length) console.log(`\nconsole errors (${consoleErrors.length}):\n` + consoleErrors.slice(0, 10).join("\n"));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; screenshot + report in ${OUT}`);
chromium.kill("SIGKILL");
process.exit(failed.length === 0 ? 0 : 1);

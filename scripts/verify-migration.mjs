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

/**
 * Poll `expression` until `ok` accepts it, then return whatever it last saw.
 *
 * For reads whose subject is built lazily — a satellite's component entities appear as
 * the satellite is enabled, not when the overlay reports it placed — so a single sample
 * races the build. It passes locally against a loopback server and fails against a
 * deployment behind a proxy, which is the worst way for a check to be wrong. Returning
 * the last value rather than throwing keeps a genuine failure legible in the report.
 */
async function sampleUntil(expression, ok, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await evaluate(expression);
    if (ok(last) || Date.now() > deadline) return last;
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

const haloLabelled = (texts) => Array.isArray(texts) && texts.length === STAGES && texts.every((text) => /^S\d+ · P\d+-\d+/.test(text ?? ""));

record(
  "each stage's halo says which satellite it is on — plane and slot, not just the stage number",
  await sampleUntil(
    "(() => { const t = window.cc.viewer.clock.currentTime;" +
      " return window.cc.viewer.entities.values.filter((e) => /^Migration host S/.test(e.name)).map((e) => e.label?.text?.getValue(t)); })()",
    haloLabelled,
  ),
  // `S2 · P01-07`: the stage, then the two numbers that place its satellite in the
  // constellation. The stage number alone left four interchangeable tags moving over a
  // fleet of twenty with no way to tell which satellite any of them was on.
  haloLabelled,
);

const fleetLabelled = (l) => l?.total === 20 && l.tagged === l.total;

record(
  "every satellite in the fleet is labelled by its plane and slot",
  await sampleUntil(
    "(() => { const t = window.cc.viewer.clock.currentTime;" +
      " const texts = window.cc.viewer.entities.values.filter((e) => e.label && !/^Migration/.test(e.name ?? ''))" +
      "   .map((e) => e.label.text?.getValue?.(t));" +
      " return { total: texts.length, tagged: texts.filter((x) => /^P\\d+-\\d+$/.test(x ?? '')).length, sample: texts.slice(0, 3) }; })()",
    fleetLabelled,
  ),
  // The whole fleet, not just the four hosts: the demo turns labels on now that a label
  // is six characters rather than the pattern's full name repeated twenty times.
  fleetLabelled,
);

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

// The migration animation rides the simulation clock (LAB-89): the packet covers
// MIGRATION_ANIMATION_SIM_SECONDS of simulated time crossing the link, so winding the
// multiplier up makes migrations quicker in wall time and pausing stops them dead.
//
// That property is checked by *stepping the clock by hand* rather than by winding the
// multiplier up and watching, because how many frames a flight spans is a function of
// the frame rate: 30 simulated seconds at 60× is half a wall second, which is under
// one frame in headless software rendering, and at 4000× a flight is over inside a
// frame on any hardware. Driving `clock.currentTime` with the clock paused removes
// the frame rate from the question entirely and asserts the actual invariant —
// progress is elapsed simulated time over the animation's simulated duration — which
// is what makes the visible speed follow the multiplier.
/** config/migration MIGRATION_ANIMATION_SIM_SECONDS — the animation's simulated duration. */
const ANIMATION_SIM_SECONDS = 30;
/** A step of a third of the way across the link, in simulated seconds. */
const THIRD = ANIMATION_SIM_SECONDS / 3;

const stepped = await evaluate(
  "(async () => {" +
    "  const clock = window.cc.viewer.clock;" +
    "  const JulianDate = clock.currentTime.constructor;" +
    "  clock.shouldAnimate = false;" +
    // Two frames per step: the layer's tick runs off clock.onTick, and the status the
    // panel and this check read is recomposed there.
    "  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));" +
    "  const advance = async (seconds) => { clock.currentTime = JulianDate.addSeconds(clock.currentTime, seconds, new JulianDate()); await frame(); };" +
    "  const stages = () => window.cc.migrationStatus?.stages ?? [];" +
    "  const flying = () => stages().find((s) => s.phase === 'migrating' && typeof s.progress === 'number');" +
    // Jump forward in coarse strides until a host loses power and its stage takes off.
    // A stride longer than the animation is fine: the flight is created and reported
    // within the tick that decides it, so it is seen at the start of its crossing.
    "  let found; const strides = [];" +
    "  for (let step = 0; step < 400 && !found; step += 1) { await advance(120); found = flying(); strides.push(step); }" +
    "  if (!found) { clock.shouldAnimate = false; return { error: 'no stage took off in 400 strides of the clock' }; }" +
    "  const of = () => stages().find((s) => s.index === found.index) ?? {};" +
    "  const destination = of().to;" +
    "  const trace = [{ advanced: 0, progress: of().progress, phase: of().phase, host: of().hostName }];" +
    // Three strides across the link, with the clock standing still in the middle: the
    // moving samples pin progress to simulated time, the still ones pin that a paused
    // clock freezes the packet where it is.
    `  for (const seconds of [${THIRD}, ${THIRD}, 0, 0, ${THIRD}]) { await advance(seconds); trace.push({ advanced: seconds, progress: of().progress, phase: of().phase, host: of().hostName }); }` +
    "  clock.shouldAnimate = false;" +
    "  return { stage: found.index, from: found.from, destination, strides: strides.length, trace };" +
    "})()",
);

record("a migration is observed in flight (packet moving over the ISL)", stepped?.trace?.[0] ?? stepped, (t) => t?.phase === "migrating" && t.progress >= 0 && t.progress < 1);

record(
  "the packet advances by the simulated time elapsed, over the animation's simulated duration",
  stepped?.trace?.map((sample) => sample.progress),
  // A third of the animation's simulated seconds is a third of the way across, twice
  // over — regardless of how long those simulated seconds took to pass on the wall
  // clock, which is the whole of the fix. Anchored to `performance.now()` these
  // samples would barely move, since the clock is paused and only being nudged.
  (p) => Array.isArray(p) && p.length === 6 && Math.abs(p[0] - 0) < 0.02 && Math.abs(p[1] - 1 / 3) < 0.02 && Math.abs(p[2] - 2 / 3) < 0.02,
);

record(
  "the packet lands on its destination exactly when the simulated duration is up",
  stepped ? { destination: stepped.destination, last: stepped.trace?.at(-1) } : null,
  // The third third completes the crossing, so the stage is no longer in flight and is
  // sitting on the satellite the link pointed at. The landing shares the packet's
  // timebase, so what a viewer sees touch down is when the ledger records the hop.
  (s) => s !== null && typeof s.destination === "string" && s.last?.phase !== "migrating" && s.last?.progress == null && s.last?.host === s.destination,
);

record(
  "a paused clock freezes the packet mid-link instead of letting it sail on",
  stepped?.trace?.slice(2, 5).map((sample) => sample.progress),
  // The user-visible complaint that opened LAB-89, at its starkest: nothing moves
  // while the clock is not moving. Two frames pass per sample and the packet has to
  // still be mid-link, not at 0 and not landed.
  (p) => Array.isArray(p) && p.length === 3 && p[0] > 0 && p[0] < 1 && p[1] === p[0] && p[2] === p[0],
);

// Now let the clock run hard so hosts cross into shadow within a few wall seconds
// instead of a real orbit, and let the ledger fill.
await evaluate("(() => { window.cc.viewer.clock.multiplier = 4000; window.cc.viewer.clock.shouldAnimate = true; return true; })()");

let sawStalled = false;
let sawAllPowered = false;
let maxMigrations = 0;
let logLength = 0;
let accounted = 0;
const hosts = new Set();
const stagesThatMoved = new Set();
// Run until the ledger has attributed time *both* ways over a run long enough to mean
// something, rather than for a fixed window: the fraction is only meaningful once it
// has, and how soon that happens depends on where the stages were placed. Watching the
// ledger directly rather than a proxy — an earlier version checked
// `poweredStages === stages.length`, which is trivially true for the empty
// pre-placement status and let the loop break before the pipeline had ever been fully
// lit.
//
// The simulated-seconds floor matters as much as the both-ways condition: the clock
// stepping above already accrues a few hundred seconds, so without it the loop breaks
// on its first poll and the served fraction is one arbitrary sliver of one orbit.
// Five orbits at 550 km is a sample whose fraction is about the geometry.
const ENOUGH_SIM_SECONDS = 30_000;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const status = await evaluate("window.cc.migrationStatus");
  if (status?.ledger?.allPoweredSeconds > 0) sawAllPowered = true;
  if (status?.ledger?.stalledSeconds > 0) sawStalled = true;
  accounted = (status?.ledger?.allPoweredSeconds ?? 0) + (status?.ledger?.stalledSeconds ?? 0);
  if (typeof status?.migrations === "number") maxMigrations = Math.max(maxMigrations, status.migrations);
  if (Array.isArray(status?.log)) {
    logLength = Math.max(logLength, status.log.length);
    // The log is where the hops are recorded, and is the honest source for which
    // satellites the pipeline has visited — polling `stages[].hostName` only sees
    // whichever hosts a stage happened to be sitting on when the poll landed, and at
    // 4000× that undersamples badly.
    for (const event of status.log) {
      stagesThatMoved.add(event.stage);
      hosts.add(event.from);
      hosts.add(event.to);
    }
  }
  for (const stage of status?.stages ?? []) if (stage.hostName) hosts.add(stage.hostName);
  if (sawStalled && sawAllPowered && maxMigrations >= 1 && logLength >= 1 && accounted >= ENOUGH_SIM_SECONDS) break;
  await sleep(400);
}

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
writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, readout, stepped, maxMigrations, hostsVisited: [...hosts], stagesThatMoved: [...stagesThatMoved] }, null, 2));

const failed = checks.filter((c) => !c.ok);
if (consoleErrors.length) console.log(`\nconsole errors (${consoleErrors.length}):\n` + consoleErrors.slice(0, 10).join("\n"));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; screenshot + report in ${OUT}`);
chromium.kill("SIGKILL");
process.exit(failed.length === 0 ? 0 : 1);

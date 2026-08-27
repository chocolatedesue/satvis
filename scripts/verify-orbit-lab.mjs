// The orbit lab's browser check: drive a *built* deployment in headless Chromium
// over CDP and assert what jsdom cannot see — that a pattern typed into the panel
// becomes satellites on a globe, and that the illumination arc's colours reach the
// screen. What each check returned last time is recorded in
// docs/manual-verification.md; this file is how to reproduce it.
//
// Node's global WebSocket (>= 22) is the whole CDP client. No puppeteer, no
// devDependency.
//
//   pnpm build && pnpm preview                       # or any static host
//   node scripts/verify-orbit-lab.mjs http://localhost:4173 /tmp/verify-out
//
//   VERIFY_PROXY=http://127.0.0.1:8080 node scripts/verify-orbit-lab.mjs https://satvis.space /tmp/out
//
// Exits non-zero on the first failed expectation, and writes screenshots plus a
// report.json into the output directory either way.
//
// Two things it has to do that look incidental and are not:
//
//   - a *fresh* browser profile every run. The app is a PWA, so a persisted profile
//     keeps its service worker, and the service worker serves the bundle it
//     precached — a reused profile silently verifies the previous build.
//   - `--enable-unsafe-swiftshader`, without which there is no WebGL context and so
//     no globe. It also means this cannot answer throughput questions: satellites
//     are built against a per-frame budget and SwiftShader renders a few frames a
//     second, so the largest pattern checked here is 348.

/* eslint-disable no-await-in-loop -- polling a live browser is sequential by nature:
   each read has to see the effect of the last one. */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:8788";
const OUT = process.argv[3] ?? "/tmp/satvis-verify";
const PORT = 9333;
mkdirSync(OUT, { recursive: true });

const chromium = spawn(
  "/usr/bin/chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // SwiftShader is what gives a headless run a WebGL context at all.
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--hide-scrollbars",
    // Only when asked: the local deploy is on the loopback interface, and this box
    // reaches the public internet through a proxy.
    ...(process.env.VERIFY_PROXY ? [`--proxy-server=${process.env.VERIFY_PROXY}`, "--proxy-bypass-list=<-loopback>"] : []),
    "--window-size=1440,900",
    `--remote-debugging-port=${PORT}`,
    // A fresh profile every run. The app is a PWA: a persisted profile keeps its
    // service worker, and the service worker serves the bundle from the *last*
    // build — so a reused profile silently verifies the previous deploy.
    `--user-data-dir=${mkdtempSync(`${tmpdir()}/satvis-verify-`)}`,
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
    if (message.error) {
      entry.reject(new Error(JSON.stringify(message.error)));
    } else {
      entry.resolve(message.result);
    }
    return;
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" "));
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
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(`${expression}\n  threw ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }
  return result.value;
}

/** Poll an expression until it is truthy, so nothing races the app's startup. */
async function until(expression, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${expression}`);
    await sleep(250);
  }
}

/** The five states, so an assertion can require all of them without repeating the hexes. */
const palette5 = { umbra: 1, penumbra: 1, sunlit_back: 1, sunlit_edge: 1, sunlit_on: 1 };

const checks = [];
function record(name, actual, expectation) {
  const ok = expectation(actual);
  checks.push({ name, actual, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(actual)}`);
}

await send("Page.enable");
await send("Runtime.enable");

// ── The app loads at all ─────────────────────────────────────────────────────
const PINNED_TIME = "2026-01-01T00:00";
await send("Page.navigate", { url: `${BASE}/?elements=Point,Orbit&tags=&time=${PINNED_TIME}` });
// The whole toolbar, not its first button: Vue mounts the row before it has filled
// it, so waiting on one button occasionally read the count back as 0.
await until("document.querySelectorAll('#toolbarLeft .toolbarButtons button').length >= 7", "the toolbar");
await until("!!document.querySelector('canvas')", "the Cesium canvas");
await sleep(6000);

record("toolbar carries the orbit lab button", await evaluate("document.querySelectorAll('#toolbarLeft .toolbarButtons button').length"), (value) => value >= 7);

// ── The lab panel opens ──────────────────────────────────────────────────────
await evaluate("document.querySelectorAll('#toolbarLeft .toolbarButtons button')[3].click()");
await until("!!document.querySelector('.orbitLab')", "the orbit lab panel");
record("panel offers all five illumination states", await evaluate("document.querySelectorAll('.orbitLab__legend tbody tr').length"), (value) => value === 5);

// ── The one-click two-orbit demo ─────────────────────────────────────────────
await evaluate("[...document.querySelectorAll('.orbitLab__button')].find((b) => /Two-orbit demo/.test(b.textContent)).click()");
await until("/walker=53%3A20|walker=53:20/.test(window.location.search)", "the demo pattern in the url");
record(
  "the demo starts the clock and speeds it up, so the motion is visible",
  await evaluate("({ multiplier: window.cc.viewer.clock.multiplier, running: window.cc.viewer.clock.shouldAnimate })"),
  (state) => state.multiplier === 60 && state.running === true,
);
record(
  "the demo writes the pattern, the arc component, the colouring and the point size in one press",
  await evaluate(`(() => {
    const q = new URLSearchParams(window.location.search);
    return { walker: q.get('walker'), elements: q.get('elements'), paint: q.get('paint'), psize: q.get('psize'), tags: q.get('tags') };
  })()`),
  (q) =>
    q.walker === "53:20/2/1@550~180" &&
    (q.elements ?? "").includes("Illumination arc") &&
    q.paint === "illumination" &&
    q.psize === "large" &&
    (q.tags ?? "").includes("Walker 53:20/2/1@550"),
);
await until(
  "Number((([...document.querySelectorAll('.orbitLab__derived')].find((p) => /satellites on screen/.test(p.textContent))?.textContent ?? '').match(/(\\d+) satellites/) ?? [0, 0])[1]) === 20",
  "the twenty demo satellites",
  180_000,
);
record(
  "two orbits, ten satellites each",
  await evaluate("([...document.querySelectorAll('.orbitLab__derived')].find((p) => /satellites on screen/.test(p.textContent))?.textContent ?? '').trim().replace(/\\s+/g, ' ')"),
  (value) => value.startsWith("20 satellites on screen"),
);
record(
  "every point is drawn at the large size",
  await evaluate(`(() => {
    const sizes = window.cc.sats.activeSatellites.map((sat) => {
      const graphics = sat.components.Point?.point;
      const size = graphics?.pixelSize;
      return size?.getValue ? size.getValue(window.cc.viewer.clock.currentTime) : size;
    });
    return [...new Set(sizes)];
  })()`),
  (sizes) => sizes.length === 1 && sizes[0] === 14,
);
record(
  "spread round two rings, the twenty satellites occupy more than one state at once",
  await evaluate(`(() => {
    const date = new Date(window.cc.viewer.clock.currentTime.toString());
    const counts = {};
    for (const sat of window.cc.sats.activeSatellites) {
      const state = sat.props.illumination(date, 'zenith')?.state;
      if (state) counts[state] = (counts[state] ?? 0) + 1;
    }
    return counts;
  })()`),
  (counts) => Object.keys(counts).length >= 2 && Object.values(counts).reduce((sum, value) => sum + value, 0) === 20,
);
// The ask this whole section exists for: the colours follow the motion. One
// satellite, two readings a simulated ten minutes apart — at 60× that is ten
// seconds of waiting, and a tenth of an orbit of travel.
const stateWalk = await evaluate(`(() => {
  const sat = window.cc.sats.activeSatellites[0];
  const start = new Date(window.cc.viewer.clock.currentTime.toString());
  const walk = [];
  for (let minute = 0; minute <= 96; minute += 4) {
    const at = new Date(start.getTime() + minute * 60_000);
    walk.push(sat.props.illumination(at, 'zenith')?.state ?? 'none');
  }
  return { name: sat.props.name, walk };
})()`);
record(
  "one satellite passes through eclipse and back over its own orbit",
  { name: stateWalk.name, distinct: [...new Set(stateWalk.walk)] },
  (result) => result.distinct.includes("umbra") && result.distinct.includes("sunlit_on") && result.distinct.length >= 3,
);
record(
  "and its live colour changes as the clock advances",
  await (async () => {
    const readState = () => evaluate("window.cc.sats.activeSatellites[0].props.illumination(new Date(window.cc.viewer.clock.currentTime.toString()), 'zenith')?.state");
    const before = await readState();
    // Long enough at 60x to cross a boundary from wherever it started: the shortest
    // run in the walk above is the penumbra, and the rest are many minutes wide.
    const seen = new Set([before]);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(1000);
      seen.add(await readState());
      if (seen.size > 1) break;
    }
    return [...seen];
  })(),
  (seen) => seen.length > 1,
);

// The arc is a Primitive built asynchronously from geometry Cesium then releases,
// so what can be asserted here is that both arcs are in the batch and a primitive
// reached the scene. That the colours are the right ones is what the unit tests on
// illuminationAlongOrbit cover, and what the screenshot shows.
record(
  "every orbit is in the illumination-arc batch, and it reached the scene",
  await evaluate(`(() => {
    const sats = window.cc?.sats;
    if (!sats) return 'no viewer handle';
    // The batch owns the arc geometries; Cesium's Primitive releases its
    // geometryInstances once built, so the batch is the only thing that can still
    // be counted. The scene primitive count is what says one was actually added.
    return { batch: sats.illuminationArcs?.size, pending: sats.illuminationArcs?.pending, scenePrimitives: window.cc.viewer.scene.primitives.length };
  })()`),
  (state) => state.batch === 20 && state.scenePrimitives > 0,
);
record(
  "each satellite carries an Illumination arc component",
  await evaluate(`(() => {
    const sats = window.cc?.sats?.activeSatellites ?? [];
    return { count: sats.length, withArc: sats.filter((sat) => sat.componentNames.includes('Illumination arc')).length };
  })()`),
  (result) => result.count === 20 && result.withArc === 20,
);
// The batch builds asynchronously, so nothing is on screen until it settles —
// which is also why the first version of this check screenshotted a bare globe.
await until("window.cc.sats.illuminationArcs.pending === false", "the arc batch to settle", 120_000);
await sleep(3000);

// What the arc actually put on screen, read off the pixels.
//
// The globe and the sky box are hidden for this one frame, so the only things left
// in it are the arcs and their points: any coloured pixel is the feature under
// test, with no background to be confused with. Restored immediately afterwards.
//
// Matched by *hue* rather than by value, because Cesium tonemaps the frame — a
// #f0e442 line arrives at about (200, 200, 40), which is the right colour at 84%
// intensity. Normalising both to their brightest channel is what makes the
// comparison about which colour it is rather than how bright the frame was.
await evaluate("window.cc.viewer.scene.globe.show = false; window.cc.viewer.scene.skyBox.show = false; window.cc.viewer.scene.requestRender();");
await sleep(2500);
const arcOnlyShot = (await send("Page.captureScreenshot", { format: "png" })).data;
writeFileSync(`${OUT}/00b-arc-colours-isolated.png`, Buffer.from(arcOnlyShot, "base64"));

const arcPixels = await evaluate(`(async () => {
  const palette = { umbra: [63, 63, 70], penumbra: [0, 114, 178], sunlit_back: [213, 94, 0], sunlit_edge: [230, 159, 0], sunlit_on: [240, 228, 66] };
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.addEventListener('load', resolve);
    image.addEventListener('error', reject);
    image.src = 'data:image/png;base64,${arcOnlyShot}';
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  // Right of the panel, above the clock deck: the legend swatches carry these same
  // five colours, and so does the deck's chrome.
  const left = 330;
  const { data } = context.getImageData(left, 0, image.width - left, image.height - 120);
  const normalise = ([r, g, b]) => {
    const peak = Math.max(r, g, b, 1);
    return [r / peak, g / peak, b / peak];
  };
  const targets = Object.entries(palette).map(([state, rgb]) => [state, normalise(rgb)]);
  const counts = {};
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    // Ignore anything too dark to have a hue at all: with the globe hidden that is
    // the empty frame. umbra is a dark neutral, so the floor has to sit below it.
    if (Math.max(r, g, b) < 40) continue;
    const [nr, ng, nb] = normalise([r, g, b]);
    for (const [state, [tr, tg, tb]] of targets) {
      if (Math.abs(nr - tr) <= 0.14 && Math.abs(ng - tg) <= 0.14 && Math.abs(nb - tb) <= 0.14) {
        counts[state] = (counts[state] ?? 0) + 1;
        break;
      }
    }
  }
  return counts;
})()`);
// Eight pixels, not a hundred: a penumbra crossing is 10-20 s of a ~96 minute
// orbit, so at any zoom that shows a whole orbit it is a few pixels of ring however
// finely it is sampled. What is being checked is that all five states are drawn —
// the proportions are the panel's job, not the picture's.
record("the arc draws every illumination state on the globe, not just in the legend", arcPixels, (counts) => Object.keys(palette5).every((state) => (counts[state] ?? 0) > 8));

await evaluate("window.cc.viewer.scene.globe.show = true; window.cc.viewer.scene.skyBox.show = true; window.cc.viewer.scene.requestRender();");
await sleep(2500);
await send("Page.captureScreenshot", { format: "png" }).then(({ data }) => writeFileSync(`${OUT}/00-two-orbit-demo.png`, Buffer.from(data, "base64")));

// ── Generating a Walker pattern ──────────────────────────────────────────────
// Back to the minimal preset, so the checks below start from a known form.
await evaluate(`(() => {
  const select = document.querySelector('.orbitLab__field select');
  const index = [...select.options].findIndex((option) => /Minimal 6\\/3\\/1/.test(option.textContent));
  select.value = String(index - 1);
  select.dispatchEvent(new Event('change'));
})()`);
record("the default preset is the minimal 6/3/1 pattern", await evaluate("document.querySelector('.orbitLab__derived').textContent.trim().replace(/\\s+/g, ' ')"), (value) =>
  value.startsWith("2 per plane"),
);

await evaluate("[...document.querySelectorAll('.orbitLab__button')].find((b) => /^(Show only|Regenerate)$/.test(b.textContent.trim())).click()");
await until("/walker=/.test(window.location.search)", "the pattern in the url");
record("the pattern lands in the url", await evaluate("new URLSearchParams(window.location.search).get('walker')"), (value) => value === "53:6/3/1@550");
record("the Walker tag is switched on", await evaluate("new URLSearchParams(window.location.search).get('tags')"), (value) => (value ?? "").includes("Walker"));

// Satellites are built off the propagation worker, so the census only fills once
// their opening sample windows land.
await until(
  "Number((([...document.querySelectorAll('.orbitLab__derived')].find((p) => /satellites on screen/.test(p.textContent))?.textContent ?? '').match(/(\\d+) satellites/) ?? [0, 0])[1]) === 6",
  "all six satellites to build",
  120_000,
);
record(
  "all six generated satellites are on screen and classified",
  await evaluate("([...document.querySelectorAll('.orbitLab__derived')].find((p) => /satellites on screen/.test(p.textContent))?.textContent ?? '').trim().replace(/\\s+/g, ' ')"),
  (value) => value.startsWith("6 satellites on screen"),
);
record(
  "the states of those six sum to six",
  await evaluate("[...document.querySelectorAll('.orbitLab__legendCount')].map((td) => Number(td.textContent))"),
  (counts) => counts.reduce((sum, value) => sum + value, 0) === 6,
);

await send("Page.captureScreenshot", { format: "png" }).then(({ data }) => writeFileSync(`${OUT}/01-walker-generated.png`, Buffer.from(data, "base64")));

// ── A bigger pattern, coloured by illumination ───────────────────────────────
// Shell 5 (348) rather than shell 1 (1584): satellites are instantiated against a
// per-frame budget, and headless SwiftShader renders a 1584-point scene at a few
// frames a second, so the larger pattern is a rendering-throughput question this
// runner cannot answer. What is being checked here is the physics and the wiring.
await evaluate(`(() => {
  const select = document.querySelector('.orbitLab__field select');
  const index = [...select.options].findIndex((option) => /Starlink shell 5/.test(option.textContent));
  select.value = String(index - 1);
  select.dispatchEvent(new Event('change'));
})()`);
record("the Starlink shell preset fills the form", await evaluate("document.querySelectorAll('.orbitLab__grid input')[0].value"), (value) => value === "348");

// Switch the colouring on before generating, so the points are built straight
// into illumination mode — which is the path a shared link takes.
await evaluate("document.querySelectorAll('input[name=pointColorMode]')[1].click()");
await until("new URLSearchParams(window.location.search).get('paint') === 'illumination'", "the paint mode in the url");
record("the paint mode lands in the url", await evaluate("new URLSearchParams(window.location.search).get('paint')"), (value) => value === "illumination");

await evaluate("[...document.querySelectorAll('.orbitLab__button')].find((b) => /^(Show only|Regenerate)$/.test(b.textContent.trim())).click()");
await until(
  "Number((([...document.querySelectorAll('.orbitLab__derived')].find((p) => /satellites on screen/.test(p.textContent))?.textContent ?? '').match(/(\\d+) satellites/) ?? [0, 0])[1]) === 348",
  "all 348 satellites to build",
  300_000,
);
const census = await evaluate(
  "([...document.querySelectorAll('.orbitLab__derived')].find((p) => /satellites on screen/.test(p.textContent))?.textContent ?? '').trim().replace(/\\s+/g, ' ')",
);
record("the whole shell is on screen", census, (value) => value.startsWith("348 satellites on screen"));
const stateCounts = await evaluate(
  "Object.fromEntries([...document.querySelectorAll('.orbitLab__legend tbody tr')].map((tr) => [tr.children[1].textContent.trim(), Number(tr.children[2].textContent)]))",
);
record("the shell is split across eclipse and panel states", stateCounts, (counts) => counts.umbra > 0 && counts.sunlit_on > 0);
record("some satellites are lit with the panel facing away", stateCounts, (counts) => counts.sunlit_back > 0);

await send("Page.captureScreenshot", { format: "png" }).then(({ data }) => writeFileSync(`${OUT}/02-illumination-shell.png`, Buffer.from(data, "base64")));

// ── One satellite's readout and its next orbit ───────────────────────────────
await evaluate(`(() => {
  // Track a generated satellite by name, which is how a url does it, then let the
  // panel pick it up as the subject.
  const url = new URL(window.location.href);
  url.searchParams.set('track', 'W97.6:348/6/58@560 P01-01');
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
})()`);
await until("!!document.querySelector('.orbitLab__strip')", "the one-orbit strip", 120_000);
const readout = await evaluate("[...document.querySelectorAll('.orbitLab__derived')].find((p) => /ν/.test(p.textContent)).textContent.trim().replace(/\\s+/g, ' ')");
record("the selected satellite reports ν, κ and β", readout, (value) => /ν \d/.test(value) && /κ -?\d/.test(value) && /β -?\d/.test(value));
record("its next orbit is more than one state", await evaluate("document.querySelectorAll('.orbitLab__strip > span').length"), (value) => value >= 2);
// The readout is the last thing in the panel, so it is the first thing to fall off
// a laptop viewport. Scrolling the panel has to be able to reach it.
await evaluate("document.querySelector('.orbitLab__strip').scrollIntoView({ block: 'center' })");
await sleep(500);
record(
  "the one-orbit strip can be scrolled into view",
  await evaluate(`(() => {
    const r = document.querySelector('.orbitLab__strip').getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: window.innerHeight, width: Math.round(r.width) };
  })()`),
  (box) => box.top >= 0 && box.bottom <= box.viewport && box.width > 100,
);
const orbitBudget = await evaluate(
  "[...document.querySelectorAll('.orbitLab__note')].find((p) => /Next \\d+ orbits/.test(p.textContent)).textContent.trim().replace(/\\s+/g, ' ')",
);
record("its eclipse budget is reported for both orbits", orbitBudget, (value) => value.startsWith("Next 2 orbits") && /umbra/.test(value) && /dark in total/.test(value));

await send("Page.captureScreenshot", { format: "png" }).then(({ data }) => writeFileSync(`${OUT}/03-satellite-readout.png`, Buffer.from(data, "base64")));

// ── Two patterns at once, entered by hand, surviving a reload ────────────────
// The question this answers: can a reader define several orbits without a rebuild,
// and does the scene come back. Typed into the form rather than picked from the
// presets, because the presets are the part that *is* in the source.
// Untrack first. The activation is tag-enabled entries *plus the tracked satellite*
// (CONTEXT.md), so the one this run tracked earlier stays on the globe however the
// tags change — and the count below would be 18 rather than 8 + 9.
await evaluate(`(() => {
  const url = new URL(window.location.href);
  url.searchParams.delete('track');
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
})()`);
await until("!new URLSearchParams(window.location.search).get('track')", "the tracked satellite to be let go");

const fields = ".orbitLab__grid input";
await evaluate(`(() => {
  const values = { 0: '8', 1: '4', 2: '1', 3: '70', 4: '700', 5: '360' };
  const inputs = document.querySelectorAll('${fields}');
  for (const [index, value] of Object.entries(values)) {
    inputs[index].value = value;
    inputs[index].dispatchEvent(new Event('input'));
  }
})()`);
await evaluate("[...document.querySelectorAll('.orbitLab__button')].find((b) => /^(Show only|Regenerate)$/.test(b.textContent.trim())).click()");
await until("/walker=70/.test(window.location.search)", "the hand-typed pattern");

await evaluate(`(() => {
  const values = { 0: '9', 1: '3', 2: '2', 3: '30', 4: '1200', 5: '360' };
  const inputs = document.querySelectorAll('${fields}');
  for (const [index, value] of Object.entries(values)) {
    inputs[index].value = value;
    inputs[index].dispatchEvent(new Event('input'));
  }
})()`);
await evaluate("[...document.querySelectorAll('.orbitLab__button')].find((b) => b.textContent.trim() === 'Add').click()");
await until(
  "Number((([...document.querySelectorAll('.orbitLab__derived')].find((p) => /satellites on screen/.test(p.textContent))?.textContent ?? '').match(/(\\d+) satellites/) ?? [0, 0])[1]) === 17",
  "both hand-typed patterns",
  180_000,
);

const bothPatterns = await evaluate(`(() => {
  const q = new URLSearchParams(window.location.search);
  return { walker: q.get('walker'), tags: q.get('tags'), listed: [...document.querySelectorAll('.orbitLab__patternName code')].map((el) => el.textContent) };
})()`);
record(
  "two hand-typed patterns are both in the url and both listed",
  bothPatterns,
  (state) =>
    (state.walker ?? "").split(",").length === 2 &&
    (state.walker ?? "").includes("70:8/4/1@700") &&
    (state.walker ?? "").includes("30:9/3/2@1200") &&
    state.listed.length === 2 &&
    (state.tags ?? "").includes("Walker 70:8/4/1@700") &&
    (state.tags ?? "").includes("Walker 30:9/3/2@1200"),
);
record(
  "and both are drawn together",
  await evaluate("([...document.querySelectorAll('.orbitLab__derived')].find((p) => /satellites on screen/.test(p.textContent))?.textContent ?? '').trim().replace(/\\s+/g, ' ')"),
  (value) => value.startsWith("17 satellites on screen"),
);

// The reload. Same url, fresh page: if the patterns only lived in memory this is
// where the scene would come back empty.
const sharedUrl = await evaluate("window.location.href");
await send("Page.navigate", { url: `${BASE}/about:blank`.replace("/about:blank", "/") });
await sleep(1500);
await send("Page.navigate", { url: sharedUrl });
await until("document.querySelectorAll('#toolbarLeft .toolbarButtons button').length >= 7", "the toolbar after the reload");
await until("(window.cc?.sats?.activeSatellites?.length ?? 0) === 17", "both constellations after the reload", 180_000);
record(
  "and the url alone rebuilds both after a reload, with no code change",
  await evaluate(`(() => {
    const names = window.cc.sats.activeSatellites.map((sat) => sat.props.name.split(' ')[0]);
    return { total: names.length, patterns: [...new Set(names)].sort() };
  })()`),
  (state) => state.total === 17 && state.patterns.length === 2,
);
await evaluate("document.querySelectorAll('#toolbarLeft .toolbarButtons button')[3].click()");
await until("!!document.querySelector('.orbitLab')", "the panel after the reload");
await sleep(1500);
await send("Page.captureScreenshot", { format: "png" }).then(({ data }) => writeFileSync(`${OUT}/04-two-patterns-after-reload.png`, Buffer.from(data, "base64")));

// ── Nothing threw along the way ──────────────────────────────────────────────
const fatal = consoleErrors.filter((line) => !/favicon|posthog|ion\.cesium|Failed to load resource/i.test(line));
record("no unexpected console errors", fatal.slice(0, 5), (list) => list.length === 0);

writeFileSync(`${OUT}/report.json`, JSON.stringify({ census, stateCounts, readout, orbitBudget, checks, consoleErrors }, undefined, 2));
console.log(`\n${checks.filter((check) => check.ok).length}/${checks.length} checks passed`);
console.log(`screenshots and report in ${OUT}`);

ws.close();
chromium.kill();
process.exit(checks.every((check) => check.ok) ? 0 : 1);

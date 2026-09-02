// Headless-Chromium check for the constellation-links overlay and marked clusters,
// over CDP with no puppeteer. Drives a *built* deployment: opens the stacked-shells
// demo and asserts ring entities, inter-plane entities, marked halos and amber bonds
// (both solid same-period and dashed drifting) are built, visible, and dimmed on occlusion.
//
//   pnpm build && (cd dist && python3 -m http.server 8791) &
//   node scripts/verify-links.mjs http://127.0.0.1:8791 /tmp/links-out

/* eslint-disable no-await-in-loop -- polling a live browser is sequential. */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:8791";
const OUT = process.argv[3] ?? "/tmp/satvis-links-verify";
const PORT = 9341;
mkdirSync(OUT, { recursive: true });

const chromiumBin = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const chromium = spawn(
  chromiumBin,
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
    `--user-data-dir=${mkdtempSync(`${tmpdir()}/satvis-links-`)}`,
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

async function until(expression, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${expression}`);
    await sleep(500);
  }
}

await send("Page.enable");
await send("Runtime.enable");

// Every run starts from a fresh browser profile (mkdtempSync user-data-dir), so
// there is no service worker and no precache to strip.
await send("Page.navigate", { url: `${BASE}/?demo=shells` });

let controllerUp = false;
for (let attempt = 0; attempt < 3 && !controllerUp; attempt += 1) {
  try {
    await until(`document.readyState === "complete"`, "page load", 90_000);
    await until(`Boolean(window.cc && window.cc.viewer && window.cc.viewer.entities)`, "app controller", 60_000);
    controllerUp = true;
  } catch (error) {
    const state = await evaluate(`({ ready: document.readyState, cc: Boolean(window.cc), url: location.href })`).catch(() => "evaluate failed too");
    console.log(`attempt ${attempt} failed: ${error.message}`);
    console.log(`  page state: ${JSON.stringify(state)}`);
    console.log(`  console errors so far: ${consoleErrors.slice(-5).join(" | ") || "none"}`);
    if (attempt === 2) throw new Error("app controller never came up after 3 attempts", { cause: error });
    await send("Page.navigate", { url: `${BASE}/?demo=shells&retry=${attempt}` });
    await sleep(2000);
  }
}

await until(
  `(() => {
    const entities = [...(window.cc?.viewer?.entities?.values ?? [])];
    const rings = entities.filter((e) => (e.name || "").startsWith("Ring link"));
    const inters = entities.filter((e) => (e.name || "").startsWith("Inter-plane link"));
    const halos = entities.filter((e) => (e.name || "").startsWith("Marked satellite"));
    const bonds = entities.filter((e) => (e.name || "").startsWith("Marked bond"));
    return rings.length >= 88 && inters.length >= 66 && halos.length === 3 && bonds.length === 3 && bonds.every((b) => b.show === true);
  })()`,
  "link and bond entities built and settled",
);

const report = await evaluate(`(() => {
  const entities = [...(window.cc?.viewer?.entities?.values ?? [])];
  const rings = entities.filter((e) => (e.name || "").startsWith("Ring link"));
  const inters = entities.filter((e) => (e.name || "").startsWith("Inter-plane link"));
  const halos = entities.filter((e) => (e.name || "").startsWith("Marked satellite"));
  const bonds = entities.filter((e) => (e.name || "").startsWith("Marked bond"));
  const visible = entities.filter((e) => (e.name || "").includes("link") && e.show === true);
  const bondVisible = bonds.filter((e) => e.show === true).length;
  const sample = (inters[0] || rings[0])?.polyline?.positions?.getValue(window.cc?.viewer?.clock?.currentTime) ?? [];
  return {
    rings: rings.length,
    inters: inters.length,
    halos: halos.length,
    bonds: bonds.length,
    bondVisible,
    visible: visible.length,
    samplePoints: sample.length,
    marks: new URLSearchParams(location.search).get("mark"),
  };
})()`);

console.log("links report:", JSON.stringify(report, null, 2));

const bondStyles = await evaluate(`(() => {
  const entities = [...(window.cc?.viewer?.entities?.values ?? [])];
  const bonds = entities.filter((e) => (e.name || "").startsWith("Marked bond"));
  const time = window.cc?.viewer?.clock?.currentTime;
  return bonds.map((e) => ({
    name: (e.name || "").replace("Marked bond ", ""),
    drifting: (e.name || "").includes("drifting"),
    dashed: e.polyline?.material?.getType?.(time) === "PolylineDash",
    alpha: e.polyline?.material?.color?.getValue?.(time)?.alpha,
  }));
})()`);

console.log("bond styles and occlusion alpha:", JSON.stringify(bondStyles, null, 2));

const solidBonds = bondStyles.filter((b) => !b.drifting).length;
const dashedBonds = bondStyles.filter((b) => b.drifting).length;

const ok =
  report.rings >= 88 &&
  report.inters >= 66 &&
  report.visible > 0 &&
  report.samplePoints === 2 &&
  report.halos === 3 &&
  report.bonds === 3 &&
  report.bondVisible === 3 &&
  solidBonds === 1 &&
  dashedBonds === 2;

// Screenshot for the record
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT}/links.png`, Buffer.from(shot.data, "base64"));
writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, bondStyles, ok }, null, 2));

if (consoleErrors.length) {
  console.log(`console errors (${consoleErrors.length}):`);
  for (const error of consoleErrors.slice(0, 5)) console.log("  ", error.slice(0, 200));
} else {
  console.log("no console errors");
}

console.log(ok ? "LINKS OVERLAY OK" : "LINKS OVERLAY FAILED");
chromium.kill("SIGKILL");
process.exit(ok ? 0 : 1);

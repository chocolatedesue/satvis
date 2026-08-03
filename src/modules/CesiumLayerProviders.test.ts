// How the offline imagery probe reads an answer, and what the fallback swaps.
//
// The interesting cases are all failures, and the sharpest one is not a failure
// at all on the wire: a dev server answering a missing manifest with 200 and the
// app shell. That is what a checkout with no `data/imagery/` actually looks like,
// and a probe that trusted `response.ok` reported the imagery present on exactly
// the checkouts it was written for. See the `OfflineHighres` note in AGENTS.md.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { imageryProviders, withoutHighresImagery } from "./CesiumLayerProviders";

/** A fetch whose answer is chosen by the test; `init` is kept for inspection. */
function stubFetch(answer: () => Response | Promise<Response>) {
  const spy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(answer()));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const manifest = () =>
  new Response('<?xml version="1.0" encoding="utf-8"?>\n<TileMap version="1.0.0"><SRS>EPSG:4326</SRS></TileMap>', {
    status: 200,
    headers: { "content-type": "application/xml" },
  });
const missing = () => new Response("", { status: 404 });
// What `pnpm dev` answers for a file that never existed.
const appShell = () => new Response("<!doctype html><html><body><div id=app></div></body></html>", { status: 200, headers: { "content-type": "text/html" } });

beforeEach(() => {
  // The probe memoises for the life of the module, which is the point of it —
  // so each test needs a module whose memo is empty.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function freshProbe() {
  return (await import("./CesiumLayerProviders")).highresImageryMissing;
}

describe("highresImageryMissing", () => {
  test("asks for the generated tileset's manifest, not the retired submodule", async () => {
    const spy = stubFetch(manifest);
    const probe = await freshProbe();
    await probe();
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toBe("data/imagery/NaturalEarthII/tilemapresource.xml");
    expect(url).not.toContain("cesium-assets");
  });

  // Not a HEAD: the Cache API ignores requests whose method is not GET, so a HEAD
  // never sees the service worker's tile cache and would report the imagery
  // missing to someone merely offline — the one situation an offline layer is for.
  test("probes with a GET, never a HEAD", async () => {
    const spy = stubFetch(manifest);
    const probe = await freshProbe();
    await probe();
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method ?? "GET").toBe("GET");
  });

  test("a manifest means present", async () => {
    stubFetch(manifest);
    await expect((await freshProbe())()).resolves.toBe(false);
  });

  test("a 404 means missing", async () => {
    stubFetch(missing);
    await expect((await freshProbe())()).resolves.toBe(true);
  });

  // The regression this probe exists for. Reading the body is what makes the
  // answer independent of how any given server handles a missing file.
  test("a 200 carrying the app shell means missing, not present", async () => {
    stubFetch(appShell);
    await expect((await freshProbe())()).resolves.toBe(true);
  });

  // An interrupted generator run, or a proxy that answered with nothing. `ok` is
  // true and the content type is even right; only the body settles it.
  test("an empty 200 means missing", async () => {
    stubFetch(() => new Response("", { status: 200, headers: { "content-type": "application/xml" } }));
    await expect((await freshProbe())()).resolves.toBe(true);
  });

  // Offline with nothing in the tile cache: the layer cannot be shown, so the
  // bundled one takes over. That is a fallback, not an error.
  test("no answer at all means missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect((await freshProbe())()).resolves.toBe(true);
  });

  test("the answer is remembered rather than re-asked", async () => {
    const spy = stubFetch(manifest);
    const probe = await freshProbe();
    await Promise.all([probe(), probe(), probe()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("withoutHighresImagery", () => {
  test("leaves a stack that names no high-resolution layer alone", () => {
    expect(withoutHighresImagery(["ArcGis", "Nextrad"])).toBeUndefined();
  });

  test("swaps in the bundled layer", () => {
    expect(withoutHighresImagery(["OfflineHighres"])).toEqual(["Offline"]);
  });

  // The user asked for a base map at a given opacity; only the source of its
  // tiles turned out to be wrong, so the opacity has to survive the swap.
  test("keeps the opacity the selection carried", () => {
    expect(withoutHighresImagery(["OfflineHighres_0.5", "Nextrad_0.5"])).toEqual(["Offline_0.5", "Nextrad_0.5"]);
  });

  test("touches nothing else in the stack", () => {
    expect(withoutHighresImagery(["OfflineHighres", "GOES-IR", "Tiles"])).toEqual(["Offline", "GOES-IR", "Tiles"]);
  });

  // The swap is only useful if its target cannot itself go missing: `Offline`
  // is copied out of node_modules by vite, so `pnpm install` guarantees it.
  test("the fallback target is a registered base layer", () => {
    expect(imageryProviders.Offline?.base).toBe(true);
  });
});

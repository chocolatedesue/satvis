// What the Map menu is allowed to offer, and how the probe reads an answer.
//
// The interesting cases are all failures. A missing asset has to disappear from
// the menu, but a dev server answering 200 with the app shell is also a missing
// asset, and an unanswered request is not a missing asset at all.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { STAR_MAPS, starMapAvailable, starMapSources } from "./starMaps";

/** A fetch whose answer per url is chosen by the test. */
function stubFetch(answer: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL) => Promise.resolve(answer(String(input))));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const imageHead = () => new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
const missing = () => new Response(null, { status: 404 });
const appShell = () => new Response(null, { status: 200, headers: { "content-type": "text/html" } });

beforeEach(() => {
  // The probe memoises for the life of the module, which is the point of it —
  // so each test needs a module whose memo is empty.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function freshModule() {
  return await import("./starMaps");
}

describe("starMapSources", () => {
  test("Tycho1K has no urls, because Cesium resolves its own", () => {
    expect(starMapSources("Tycho1K")).toBeUndefined();
  });

  test("an unknown name has no urls either", () => {
    expect(starMapSources("Nonsense")).toBeUndefined();
  });

  test.each(["Tycho2K", "DeepStar2K"])("%s names all six faces", (name) => {
    const sources = starMapSources(name);
    expect(sources && Object.keys(sources).toSorted()).toEqual(["negativeX", "negativeY", "negativeZ", "positiveX", "positiveY", "positiveZ"]);
    // Six distinct files, not the same one under six keys.
    expect(new Set(Object.values(sources!)).size).toBe(6);
  });

  test("the two 2K maps come from different places", () => {
    expect(starMapSources("Tycho2K")!.positiveX).toContain("data/cesium-assets/stars/");
    expect(starMapSources("DeepStar2K")!.positiveX).toContain("data/generated/starmap/");
  });
});

describe("starMapAvailable", () => {
  test("Tycho1K needs no probe: it ships inside Cesium", async () => {
    const spy = stubFetch(missing);
    await expect(starMapAvailable("Tycho1K")).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  test("an unknown name is never available", async () => {
    stubFetch(imageHead);
    await expect(starMapAvailable("Nonsense")).resolves.toBe(false);
  });

  test("an image answer means present", async () => {
    stubFetch(imageHead);
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(true);
  });

  test("a 404 means absent", async () => {
    stubFetch(missing);
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(false);
  });

  test("a 200 that is not an image means absent — an SPA fallback is not the asset", async () => {
    stubFetch(appShell);
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(false);
  });

  test("no answer at all means available: offline is not evidence of absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(true);
  });

  test("the answer is remembered rather than re-asked", async () => {
    const spy = stubFetch(imageHead);
    const { starMapAvailable: probe } = await freshModule();
    await Promise.all([probe("DeepStar2K"), probe("DeepStar2K"), probe("DeepStar2K")]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("availableStarMaps", () => {
  test("keeps STAR_MAPS order rather than probe completion order", async () => {
    // Answer DeepStar2K first, so a list built from resolution order would invert.
    stubFetch((url) => (url.includes("generated") ? imageHead() : new Promise((r) => setTimeout(() => r(imageHead()), 5))));
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toEqual([...STAR_MAPS]);
  });

  test("drops what is missing and always keeps the builtin", async () => {
    stubFetch((url) => (url.includes("generated") ? missing() : imageHead()));
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toEqual(["Tycho1K", "Tycho2K"]);
  });

  test("with neither optional asset the group is still not empty", async () => {
    stubFetch(missing);
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toEqual(["Tycho1K"]);
  });
});

describe("the menu and the url vocabulary are deliberately different", () => {
  test("a map absent from the server stays a legal url value", async () => {
    stubFetch(missing);
    const { availableStarMaps: list, STAR_MAPS: all } = await freshModule();
    expect(await list()).not.toContain("DeepStar2K");
    // enumString in the store is built from STAR_MAPS, not from what is present.
    expect(all).toContain("DeepStar2K");
  });
});

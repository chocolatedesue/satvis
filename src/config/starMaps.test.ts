// What the Map menu is allowed to offer, and how the probe reads an answer.
//
// The interesting cases are all failures. A missing asset has to disappear from
// the menu, but a dev server answering 200 with the app shell is also a missing
// asset, and an unanswered request is not a missing asset at all.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { BUILTIN_STAR_MAP, STAR_MAPS, starMapAvailable, starMapRecovery, starMapSources } from "./starMaps";

/** A fetch whose answer per url is chosen by the test; `init` is kept for inspection. */
function stubFetch(answer: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(answer(String(input))));
  vi.stubGlobal("fetch", spy);
  return spy;
}

// 206, because the probe asks for one byte; `response.ok` has to accept it.
const imagePart = () => new Response(null, { status: 206, headers: { "content-type": "image/jpeg" } });
const imageWhole = () => new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
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

  test("DeepStar2K names all six faces", () => {
    const sources = starMapSources("DeepStar2K");
    expect(sources && Object.keys(sources).toSorted()).toEqual(["negativeX", "negativeY", "negativeZ", "positiveX", "positiveY", "positiveZ"]);
    // Six distinct files, not the same one under six keys.
    expect(new Set(Object.values(sources!)).size).toBe(6);
  });

  test("DeepStar2K is served from the generated directory, not the submodule", () => {
    expect(starMapSources("DeepStar2K")!.positiveX).toContain("data/generated/starmap/");
  });

  test("every map is either builtin or has sources — no third state", () => {
    for (const name of STAR_MAPS) {
      expect(name === BUILTIN_STAR_MAP || starMapSources(name) !== undefined).toBe(true);
    }
  });
});

describe("starMapRecovery", () => {
  test("names the generator for the map the generator builds", () => {
    expect(starMapRecovery("DeepStar2K")).toBe("scripts/starmap/generate.sh");
  });

  test("the builtin has nothing to recover", () => {
    expect(starMapRecovery(BUILTIN_STAR_MAP)).toBeUndefined();
  });

  // The warning in sceneSync is the only thing a reader gets, and it used to
  // tell everyone to init a submodule regardless of which map had failed.
  test("a hint exists for every map that can actually go missing", () => {
    for (const name of STAR_MAPS) {
      if (starMapSources(name) !== undefined) {
        expect(starMapRecovery(name)).toBeTruthy();
      }
    }
  });
});

describe("starMapAvailable", () => {
  test("the builtin needs no probe: it ships inside Cesium", async () => {
    const spy = stubFetch(missing);
    await expect(starMapAvailable(BUILTIN_STAR_MAP)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  test("an unknown name is never available", async () => {
    stubFetch(imagePart);
    await expect(starMapAvailable("Nonsense")).resolves.toBe(false);
  });

  // Not a HEAD: the Cache API ignores requests whose method is not GET, so a
  // HEAD never sees the service worker's runtime cache and would report the map
  // missing to someone merely offline. Same rule as the imagery probe in
  // CesiumLayerProviders.ts. Ranged, because a face is ~600 kB.
  test("probes with a one-byte ranged GET, never a HEAD", async () => {
    const spy = stubFetch(imagePart);
    const { starMapAvailable: probe } = await freshModule();
    await probe("DeepStar2K");
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>)?.Range).toBe("bytes=0-0");
  });

  test("a partial image answer means present", async () => {
    stubFetch(imagePart);
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(true);
  });

  // A cache hit, or a server that ignores Range, answers with the whole file.
  test("a whole image answer means present too", async () => {
    stubFetch(imageWhole);
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
    const spy = stubFetch(imagePart);
    const { starMapAvailable: probe } = await freshModule();
    await Promise.all([probe("DeepStar2K"), probe("DeepStar2K"), probe("DeepStar2K")]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("availableStarMaps", () => {
  test("keeps STAR_MAPS order rather than probe completion order", async () => {
    // Delay the probed map, so a list built from resolution order would put the
    // unprobed builtin first only by accident — it has to be by construction.
    stubFetch(() => new Promise((r) => setTimeout(() => r(imagePart()), 5)));
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toEqual([...STAR_MAPS]);
  });

  test("drops what is missing and always keeps the builtin", async () => {
    stubFetch(missing);
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toEqual([BUILTIN_STAR_MAP]);
  });

  test("the group is never empty, whatever the probes say", async () => {
    stubFetch(appShell);
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toContain(BUILTIN_STAR_MAP);
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

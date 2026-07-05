import { createExecutionContext, createScheduledController, env, fetchMock, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import generatedConfig from "../src/config/groups.generated.json" with { type: "json" };
import { collectSources } from "../src/gp/evaluate.ts";
import type { GroupsConfig, GroupsIndex, OmmRecord } from "../src/gp/types.ts";
import worker from "../src/index.ts";

// Number of distinct upstream requests one refresh makes (sources deduped
// across all generated groups). Used to size the fetch-mock interceptors so
// they are fully consumed and never leak between tests.
const SOURCE_COUNT = collectSources((generatedConfig as GroupsConfig).groups).length;

const UPDATED = "2026-07-04T00:00:00.000Z";
const UPDATED_MS = Date.parse(UPDATED);

function ommArray(...pairs: [string, number][]): OmmRecord[] {
  return pairs.map(([name, id]) => ({ OBJECT_NAME: name, NORAD_CAT_ID: id }));
}

async function seedGroup(name: string, records: OmmRecord[], updated = UPDATED): Promise<void> {
  await env.GP_KV.put(`gp:${name}`, JSON.stringify(records), { metadata: { updated, count: records.length } });
}

describe("GET /api/gp/<group>.json", () => {
  beforeEach(async () => {
    await seedGroup("weather", ommArray(["GOES 16", 41866], ["NOAA 20 (JPSS-1)", 43013]));
  });

  it("serves records with caching headers", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("ETag")).toBe(`W/"weather-${UPDATED_MS}"`);
    expect(res.headers.get("Last-Modified")).toBe(new Date(UPDATED_MS).toUTCString());
    const body = (await res.json()) as OmmRecord[];
    expect(body.map((r) => r.OBJECT_NAME)).toEqual(["GOES 16", "NOAA 20 (JPSS-1)"]);
  });

  it("returns 304 for matching If-None-Match", async () => {
    const etag = `W/"weather-${UPDATED_MS}"`;
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json", { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("returns 200 (not 304) for a stale If-None-Match", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json", { headers: { "If-None-Match": 'W/"weather-1"' } });
    expect(res.status).toBe(200);
  });

  it("404s an unknown group", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/nonesuch.json");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("404s an invalid group name", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/..%2Fsecret.json");
    expect(res.status).toBe(404);
  });
});

describe("index and metadata routes", () => {
  it("serves gp:index at /api/groups.json", async () => {
    const index: GroupsIndex = { updated: UPDATED, groups: [{ name: "weather", updated: UPDATED, count: 2 }] };
    await env.GP_KV.put("gp:index", JSON.stringify(index));
    const res = await SELF.fetch("https://satvis.space/api/groups.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsIndex;
    expect(body.groups[0]?.name).toBe("weather");
  });

  it("serves an empty index when none is stored", async () => {
    await env.GP_KV.delete("gp:index");
    const res = await SELF.fetch("https://satvis.space/api/groups.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsIndex;
    expect(body.groups).toEqual([]);
  });

  it("serves metadata rules at /api/metadata.json", async () => {
    const res = await SELF.fetch("https://satvis.space/api/metadata.json");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("404s an unknown /api/* path", async () => {
    const res = await SELF.fetch("https://satvis.space/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("scheduled() refresh", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  // Assert every interceptor was consumed, so nothing leaks into the next test
  // (the mock agent keeps interceptors across activate/deactivate cycles).
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
  });

  // Reply to every celestrak request (regular gp.php GROUP=<g> and supplemental
  // sup-gp.php FILE=<f>) — one per distinct source — with a synthetic response,
  // so the refresh never hits the network. Sized to exactly SOURCE_COUNT so all
  // interceptors are consumed within this test.
  function interceptCelestrak(reply: (group: string) => unknown, opts?: { status?: number }): void {
    fetchMock
      .get("https://celestrak.org")
      .intercept({ method: "GET", path: (p) => p.startsWith("/NORAD/elements/gp.php") || p.startsWith("/NORAD/elements/supplemental/sup-gp.php") })
      .reply((options) => {
        const params = new URL(`https://celestrak.org${options.path}`).searchParams;
        const source = params.get("GROUP") ?? params.get("FILE") ?? "";
        return { statusCode: opts?.status ?? 200, data: JSON.stringify(reply(source)) };
      })
      .times(SOURCE_COUNT);
  }

  it("writes evaluated groups to KV and builds the index", async () => {
    interceptCelestrak((group) => [{ OBJECT_NAME: `${group.toUpperCase()}-1`, NORAD_CAT_ID: 10000 + group.length }]);

    const ctx = createExecutionContext();
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: "23 */3 * * *" });
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const weather = await env.GP_KV.get("gp:weather", "json");
    expect(Array.isArray(weather)).toBe(true);

    const index = (await env.GP_KV.get("gp:index", "json")) as GroupsIndex;
    const weatherStatus = index.groups.find((g) => g.name === "weather");
    expect(weatherStatus?.count).toBeGreaterThan(0);
    expect(weatherStatus?.lastError).toBeUndefined();
    // The derived `move` group selects FIRST-MOVE/MOVE-II from `active`; our
    // synthetic ACTIVE-1 record matches neither, so it is empty but successful.
    expect(index.groups.some((g) => g.name === "move")).toBe(true);
    // `move-sats` documents FIRST-MOVE/MOVE-II as satellites rows with noradIds;
    // the synthetic ACTIVE-1 matches neither id, so both rows raise a
    // matched-no-record warning that must surface in the index.
    const moveSatsStatus = index.groups.find((g) => g.name === "move-sats");
    expect(moveSatsStatus).toBeDefined();
    expect(moveSatsStatus?.lastError).toBeUndefined();
    expect(moveSatsStatus?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("matched no record")]));
  });

  it("preserves last-known-good on failure", async () => {
    // Seed a good weather value and index first.
    await seedGroup("weather", ommArray(["GOOD SAT", 1]), "2026-01-01T00:00:00.000Z");
    await env.GP_KV.put(
      "gp:index",
      JSON.stringify({ updated: "2026-01-01T00:00:00.000Z", groups: [{ name: "weather", updated: "2026-01-01T00:00:00.000Z", count: 1 }] } satisfies GroupsIndex),
    );

    // All upstream requests now fail (HTTP 503).
    interceptCelestrak(() => [], { status: 503 });

    const ctx = createExecutionContext();
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: "23 */3 * * *" });
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    // Last-known-good value stays in KV.
    const weather = (await env.GP_KV.get("gp:weather", "json")) as OmmRecord[];
    expect(weather.map((r) => r.OBJECT_NAME)).toEqual(["GOOD SAT"]);

    // Index keeps the old `updated` and records lastError.
    const index = (await env.GP_KV.get("gp:index", "json")) as GroupsIndex;
    const weatherStatus = index.groups.find((g) => g.name === "weather");
    expect(weatherStatus?.updated).toBe("2026-01-01T00:00:00.000Z");
    expect(weatherStatus?.lastError).toBeTruthy();
    expect(weatherStatus?.lastErrorAt).toBeTruthy();
  });
});

// Fetch-handler routing for the GP data API.

import { coerceIndex } from "./evaluate.ts";
import { refreshAll } from "./refresh.ts";
import { GP_INDEX_KEY, GP_KEY_PREFIX, type GroupWriteMetadata } from "./store.ts";

const GROUP_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// Cooldown for POST /api/refresh: within this window of the last refresh (manual
// OR cron) the endpoint will not re-hit CelesTrak. A second line of defence
// behind the bearer token, and short enough for iterative debugging.
const REFRESH_COOLDOWN_MS = 60_000;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function notFound(): Response {
  return jsonResponse({ error: "Not Found" }, { status: 404 });
}

// GET /api/gp/<group>.json — serve a group's records from KV with caching
// headers and conditional-request (If-None-Match -> 304) support.
async function handleGroup(name: string, request: Request, env: Env): Promise<Response> {
  if (!GROUP_NAME_RE.test(name)) {
    return notFound();
  }
  const { value, metadata } = await env.GP_KV.getWithMetadata<GroupWriteMetadata>(GP_KEY_PREFIX + name, {
    type: "text",
    cacheTtl: 300,
  });
  if (value === null) {
    return notFound();
  }

  const updated = metadata?.updated;
  const updatedMs = updated ? Date.parse(updated) : Date.now();
  const etag = `W/"${name}-${updatedMs}"`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300",
    ETag: etag,
    "Last-Modified": new Date(updatedMs).toUTCString(),
  };

  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(value, { headers });
}

async function handleIndex(env: Env): Promise<Response> {
  const index = await env.GP_KV.get(GP_INDEX_KEY, "text");
  if (index === null) {
    return jsonResponse({ updated: "", groups: [] });
  }
  return new Response(index, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

// POST /api/refresh — run the same refresh as the cron (fetch every source,
// evaluate, write KV) and return a per-source diagnostic report. Needs
// `Authorization: Bearer <REFRESH_TOKEN>`: one run pulls ~12 MB from CelesTrak,
// which firewalls by IP (250 MB/day) — and a Worker's egress IP is shared with
// other Cloudflare tenants, so an open trigger risks a block that stalls the cron
// for everyone. Also rate-limited: within REFRESH_COOLDOWN_MS of the last refresh
// it does NOT re-fetch, instead returning the cached index (errors included) with
// 429 so a caller keeps visibility without spending the budget. Whatever it does
// fetch is persisted, so — unlike a read-only probe — it never wastes a download.
// Its diagnostics matter most run against the deployed Worker, where failures
// like the 522s an IP block produces reproduce (they never do from a laptop).
async function handleRefresh(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  // Secrets live outside wrangler.jsonc, so `wrangler types` cannot see this one.
  // An unset secret disables the endpoint rather than leaving it open.
  const expected = (env as Env & { REFRESH_TOKEN?: string }).REFRESH_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "Refresh is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (request.headers.get("Authorization") !== `Bearer ${expected}`) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const previous = coerceIndex(await env.GP_KV.get(GP_INDEX_KEY, "json"));
  const sinceMs = Date.now() - Date.parse(previous.updated);
  if (Number.isFinite(sinceMs) && sinceMs < REFRESH_COOLDOWN_MS) {
    const retryAfterMs = REFRESH_COOLDOWN_MS - sinceMs;
    return jsonResponse(
      { refreshed: false, reason: "cooldown", updatedAt: previous.updated, retryAfterMs, groups: previous.groups },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)), "Cache-Control": "no-store" } },
    );
  }

  const report = await refreshAll(env);
  return jsonResponse(
    {
      refreshed: true,
      updatedAt: report.index.updated,
      durationMs: report.durationMs,
      written: report.written,
      skipped: report.skipped,
      sources: report.sources,
      groups: report.index.groups,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Route any /api/* request. Returns null for non-api paths so the caller can
// fall through to static assets.
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) {
    return null;
  }

  const groupMatch = /^\/api\/gp\/([^/]+)\.json$/.exec(path);
  if (groupMatch) {
    // Malformed percent-encoding (e.g. /api/gp/%zz.json) throws URIError; treat
    // it as an unknown group rather than a 500 (handleGroup's name check rejects
    // anything exotic that does decode anyway).
    let name: string;
    try {
      name = decodeURIComponent(groupMatch[1]!);
    } catch {
      return notFound();
    }
    return handleGroup(name, request, env);
  }
  if (path === "/api/groups.json") {
    return handleIndex(env);
  }
  if (path === "/api/refresh") {
    return handleRefresh(request, env);
  }
  return notFound();
}

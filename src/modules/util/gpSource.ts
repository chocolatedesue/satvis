// GpSource — the single place that knows where GP data comes from. Hides the
// worker probe, its memoization, the two URL schemes, and the API→static
// fallback behind two fetch-shaped functions: fetchGpIndex and fetchGpGroup.
//
// On first use we probe `/api/groups.json`. If a worker answers with a
// parseable JSON body we use the API base `/api/gp/` and keep the returned
// group index (names + counts); otherwise we fall back to the static snapshot
// under `data/gp/` (written by `pnpm update-gp`, served as part of the static
// build) and read its `index.json` instead. The probe runs once per session
// (memoized promise). When the worker API fails for a single group
// mid-session, that request is retried once against the static snapshot.

const API_BASE = "/api/gp/";
const STATIC_BASE = "data/gp/";
const PROBE_URL = "/api/groups.json";
const STATIC_INDEX_URL = "data/gp/index.json";
const PROBE_TIMEOUT_MS = 3000;

// One entry of the group index (`/api/groups.json` or `data/gp/index.json`,
// same shape): the group name plus its record count for UI display.
export interface GpIndexEntry {
  name: string;
  updated?: string;
  count?: number;
}

interface GpSourceInfo {
  base: string;
  index: GpIndexEntry[];
}

let infoPromise: Promise<GpSourceInfo> | undefined;

function parseIndex(payload: unknown): GpIndexEntry[] {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { groups?: unknown }).groups)) {
    return [];
  }
  return ((payload as { groups: unknown[] }).groups as GpIndexEntry[]).filter((group) => typeof group?.name === "string");
}

async function fetchStaticIndex(): Promise<GpIndexEntry[]> {
  try {
    const response = await fetch(STATIC_INDEX_URL);
    if (!response.ok) {
      return [];
    }
    return parseIndex(await response.json());
  } catch {
    return [];
  }
}

async function probeGpSource(): Promise<GpSourceInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(PROBE_URL, { signal: controller.signal });
    if (!response.ok) {
      return { base: STATIC_BASE, index: await fetchStaticIndex() };
    }
    // A worker-less deployment may answer the probe with the SPA index HTML
    // (200 + text/html). Require a parseable JSON body to accept the API base.
    const payload = (await response.json()) as unknown;
    return { base: API_BASE, index: parseIndex(payload) };
  } catch {
    return { base: STATIC_BASE, index: await fetchStaticIndex() };
  } finally {
    clearTimeout(timer);
  }
}

function resolveGpSource(): Promise<GpSourceInfo> {
  infoPromise ??= probeGpSource();
  return infoPromise;
}

// Resolve a preset source into a fetchable URL. Bare group names
// (^[a-zA-Z0-9_-]+$) are resolved against the probed base; anything containing
// "/" or "." (legacy .txt URLs, absolute/relative paths) passes through
// unchanged so it can still be parsed via payload sniffing.
function resolveGroupUrl(source: string, base: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(source)) {
    return `${base}${source}.json`;
  }
  return source;
}

// Static-snapshot URL for a bare group name, used as a per-request fallback
// when the worker API fails mid-session. Explicit URL sources have no static
// counterpart and return undefined.
function staticGroupUrl(source: string): string | undefined {
  if (/^[a-zA-Z0-9_-]+$/.test(source)) {
    return `${STATIC_BASE}${source}.json`;
  }
  return undefined;
}

// The group index (names + counts) from the probe. Best-effort: empty when
// neither the worker nor the static snapshot answers; never rejects.
export async function fetchGpIndex(): Promise<GpIndexEntry[]> {
  return (await resolveGpSource()).index;
}

// The payload text for a preset source. Bare group names resolve against the
// probed base; when the worker API fails mid-session (network error or
// non-2xx), the request is retried once against the static snapshot bundled
// with the build. Explicit URL sources pass through without a fallback.
export async function fetchGpGroup(source: string): Promise<string> {
  const { base } = await resolveGpSource();
  const url = resolveGroupUrl(source, base);
  try {
    // Plain fetch (NOT mode:"no-cors") — the API is same-origin; an opaque
    // response would have an unreadable body and break parsing.
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return await response.text();
  } catch (error) {
    const fallback = staticGroupUrl(source);
    if (fallback === undefined || fallback === url) {
      throw error;
    }
    console.log(`GP fetch failed for ${url}, retrying static snapshot ${fallback}`, error);
    const response = await fetch(fallback);
    if (!response.ok) {
      throw new Error(response.statusText, { cause: error });
    }
    return await response.text();
  }
}

// Test seam: the probe is otherwise memoized for the life of the module.
export function resetGpSource(): void {
  infoPromise = undefined;
}

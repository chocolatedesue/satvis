// GP base resolution for worker vs. worker-less (static snapshot) deployments.
//
// On the first call we probe `/api/groups.json`. If a worker answers with a
// parseable JSON body we use the API base `/api/gp/` and keep the returned
// group index (names + counts); otherwise we fall back to the static snapshot
// under `data/gp/` (written by `pnpm update-gp`, served as part of the static
// build) and read its `index.json` instead. The probe runs once per session
// (memoized promise).

const API_BASE = "/api/gp/";
const STATIC_BASE = "data/gp/";
const PROBE_URL = "/api/groups.json";
const API_METADATA_URL = "/api/metadata.json";
const STATIC_METADATA_URL = "data/gp/metadata.json";
const STATIC_INDEX_URL = "data/gp/index.json";
const PROBE_TIMEOUT_MS = 3000;

// One entry of the group index (`/api/groups.json` or `data/gp/index.json`,
// same shape): the group name plus its record count for UI display.
export interface GpIndexEntry {
  name: string;
  updated?: string;
  count?: number;
}

export interface GpSourceInfo {
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

// Base plus the group index (names + counts) from the same probe request.
export function resolveGpSource(): Promise<GpSourceInfo> {
  infoPromise ??= probeGpSource();
  return infoPromise;
}

export async function resolveGpBase(): Promise<string> {
  return (await resolveGpSource()).base;
}

// For tests: reset the memoized probe.
export function resetGpBase(): void {
  infoPromise = undefined;
}

// Resolve a preset source into a fetchable URL. Bare group names
// (^[a-zA-Z0-9_-]+$) are resolved against the probed base; anything containing
// "/" or "." (legacy .txt URLs, absolute/relative paths) passes through
// unchanged so it can still be parsed via payload sniffing.
export function resolveGroupUrl(source: string, base: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(source)) {
    return `${base}${source}.json`;
  }
  return source;
}

// Static-snapshot URL for a bare group name, used as a per-request fallback
// when the worker API fails mid-session. Explicit URL sources have no static
// counterpart and return undefined.
export function staticGroupUrl(source: string): string | undefined {
  if (/^[a-zA-Z0-9_-]+$/.test(source)) {
    return `${STATIC_BASE}${source}.json`;
  }
  return undefined;
}

// The metadata endpoint for the resolved base: the worker serves it at
// `/api/metadata.json`; the static snapshot writes `data/gp/metadata.json`.
export function resolveMetadataUrl(base: string): string {
  return base === API_BASE ? API_METADATA_URL : STATIC_METADATA_URL;
}

export { API_BASE, STATIC_BASE };

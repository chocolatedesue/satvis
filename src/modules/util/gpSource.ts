// GP base resolution for worker vs. worker-less (static snapshot) deployments.
//
// On the first call we probe `/api/groups.json`. If a worker answers with a
// parseable JSON body we use the API base `/api/gp/`; otherwise we fall back to
// the static snapshot under `data/gp/` (written by `pnpm update-gp`, served as
// part of the static build). The probe runs once per session (memoized promise).

const API_BASE = "/api/gp/";
const STATIC_BASE = "data/gp/";
const PROBE_URL = "/api/groups.json";
const API_METADATA_URL = "/api/metadata.json";
const STATIC_METADATA_URL = "data/gp/metadata.json";
const PROBE_TIMEOUT_MS = 3000;

let basePromise: Promise<string> | undefined;

async function probeGpBase(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(PROBE_URL, { signal: controller.signal });
    if (!response.ok) {
      return STATIC_BASE;
    }
    // A worker-less deployment may answer the probe with the SPA index HTML
    // (200 + text/html). Require a parseable JSON body to accept the API base.
    await response.json();
    return API_BASE;
  } catch {
    return STATIC_BASE;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveGpBase(): Promise<string> {
  basePromise ??= probeGpBase();
  return basePromise;
}

// For tests: reset the memoized probe.
export function resetGpBase(): void {
  basePromise = undefined;
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

// The metadata endpoint for the resolved base: the worker serves it at
// `/api/metadata.json`; the static snapshot writes `data/gp/metadata.json`.
export function resolveMetadataUrl(base: string): string {
  return base === API_BASE ? API_METADATA_URL : STATIC_METADATA_URL;
}

export { API_BASE, STATIC_BASE };

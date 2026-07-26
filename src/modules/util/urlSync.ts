// Keeps the url in step with the stores that opt in via their `urlsync`
// option. All the encoding lives in ./urlCodec; this module is the adapter
// that owns the impure parts — the router, and deciding what becomes a
// history entry.
//
// The contract is docs/adr/0001-url-parameter-specification.md.

import type { PiniaPluginContext, Store as PiniaStore } from "pinia";
import { watch } from "vue";
import type { LocationQuery, Router } from "vue-router";

import { decode, encode, type FieldSpec, type Query } from "./urlCodec";

export type { FieldKind, FieldSpec } from "./urlCodec";

interface UrlSyncConfig {
  enabled?: boolean;
  config: FieldSpec[];
  // How a decoded patch reaches the store. Stores with guarded keys supply
  // this so the url goes through the same actions as every other writer;
  // without it each key is assigned directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply?: (store: any, patch: Record<string, unknown>) => void;
}

declare module "pinia" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export interface DefineStoreOptionsBase<S, Store> {
    urlsync?: UrlSyncConfig;
  }
}

// Injected by the plugin registered ahead of this one in src/app.ts.
interface ExtendedStore extends PiniaStore {
  router: Router;
  customConfig: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

interface Registration {
  store: ExtendedStore;
  specs: FieldSpec[];
  apply: UrlSyncConfig["apply"];
  // Store keys are qualified with the store id so two stores can use the same
  // key name without colliding in the shared rebuild below.
  qualified: FieldSpec[];
  // Preset-merged values, captured at hydration. Undefined until then, which
  // is also how we know this store's parameters must not be rewritten yet.
  defaults?: Record<string, unknown>;
}

// Every synced store, so one write can rebuild the whole query. Without this
// the url is an integration channel between stores, each preserving the
// other's parameters by reading them back out of the current location.
const registry = new Map<string, Registration>();
let watching = false;

const paramOf = (spec: FieldSpec) => spec.url ?? spec.name;
const qualify = (storeId: string, specs: FieldSpec[]): FieldSpec[] => specs.map((spec) => ({ ...spec, name: `${storeId}.${spec.name}` }));
const hydratedEntries = () => [...registry.values()].filter((entry) => entry.defaults !== undefined);

// vue-router hands back string | null | (string | null)[]; the codec wants one
// string per parameter. A repeated parameter keeps its first value.
function normalizeQuery(query: LocationQuery): Query {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") {
      normalized[key] = first;
    }
  }
  return normalized;
}

// Values reach the store as fresh arrays and objects on every decode, so
// identity is useless for deciding whether anything actually changed. Without
// this every url write would echo back as a store write and round again.
function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// Guarded keys are read-only computeds, so a store that has any must route
// writes through its actions. Assigning them directly would silently do
// nothing beyond a Vue warning.
function commit(entry: Registration, patch: Record<string, unknown>): void {
  if (entry.apply) {
    entry.apply(entry.store, patch);
    return;
  }
  Object.assign(entry.store, patch);
}

function applyQuery(entry: Registration, query: Query): void {
  const { patch, invalid } = decode(query, entry.qualified, entry.defaults ?? {});

  // Back to unqualified store keys, and note whether anything actually moved:
  // decode hands back fresh arrays every time, so a blind apply would churn.
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [index, spec] of entry.specs.entries()) {
    const value = patch[entry.qualified[index]!.name];
    next[spec.name] = value;
    if (!isSameValue(entry.store[spec.name], value)) {
      changed = true;
    }
  }

  if (changed) {
    commit(entry, next);
  }

  for (const param of invalid) {
    console.warn(`Ignoring invalid url parameter: ${param}`);
  }
}

// Rebuild the entire query from every hydrated store. Parameters belonging to
// stores that have not hydrated yet are treated as foreign and preserved, so a
// store created late cannot have its url read out from under it.
function writeQuery(router: Router, mode: "push" | "replace"): void {
  const hydrated = hydratedEntries();
  if (hydrated.length === 0) {
    return;
  }

  const current = normalizeQuery(router.currentRoute.value.query);
  const owned = new Set(hydrated.flatMap((entry) => entry.specs.map(paramOf)));
  const foreign = Object.fromEntries(Object.entries(current).filter(([param]) => !owned.has(param)));

  const state: Record<string, unknown> = {};
  const defaults: Record<string, unknown> = {};
  const schema: FieldSpec[] = [];
  for (const entry of hydrated) {
    for (const [index, spec] of entry.specs.entries()) {
      const qualified = entry.qualified[index]!;
      state[qualified.name] = entry.store[spec.name];
      schema.push(qualified);
    }
    Object.assign(defaults, entry.defaults);
  }

  const next = encode(state, defaults, schema, foreign);
  // A write that changes nothing is not a state change and must not become a
  // history entry — catalogRevision and pickMode both fire $subscribe. This is
  // also what stops a push from echoing back through the query watcher.
  if (isSameValue(next, current)) {
    return;
  }
  void router[mode]({ query: next }).catch(() => {
    // A redundant navigation is not an error worth surfacing.
  });
}

// Back and forward change the query without touching the store, so the url has
// to be re-applied. One watcher covers every store: the query is rebuilt whole,
// so it is never partially owned.
function watchQuery(router: Router): void {
  if (watching) {
    return;
  }
  watching = true;
  watch(
    () => router.currentRoute.value.query,
    (query) => {
      const normalized = normalizeQuery(query);
      for (const entry of hydratedEntries()) {
        applyQuery(entry, normalized);
      }
    },
  );
}

function hydrate(entry: Registration, router: Router): void {
  const { store, specs } = entry;

  // The preset supplies this route's defaults, so it is applied before the
  // defaults are captured and before the url is read. It sets only some keys,
  // so the rest are carried over to make a whole patch for commit().
  const preset = store.customConfig[store.$id];
  if (preset) {
    const merged: Record<string, unknown> = {};
    for (const spec of specs) {
      merged[spec.name] = spec.name in preset ? preset[spec.name] : store[spec.name];
    }
    commit(entry, merged);
    // Anything the preset sets that is not url-synced has no schema entry.
    for (const [key, value] of Object.entries(preset)) {
      if (!specs.some((spec) => spec.name === key)) {
        store[key] = value;
      }
    }
  }

  const defaults: Record<string, unknown> = {};
  for (const [index, spec] of specs.entries()) {
    defaults[entry.qualified[index]!.name] = store[spec.name];
  }
  entry.defaults = defaults;

  applyQuery(entry, normalizeQuery(router.currentRoute.value.query));

  // Normalise the url to what the state actually is — dropping anything
  // invalid and anything that turned out to equal a default. Replace rather
  // than push: arriving at a page is not a state change.
  writeQuery(router, "replace");
  watchQuery(router);
}

function createUrlSync({ options, store }: PiniaPluginContext): void {
  const urlsync = options.urlsync;
  if (!urlsync?.enabled && !urlsync?.config) {
    return;
  }

  const extended = store as unknown as ExtendedStore;
  const { router } = extended;
  const entry: Registration = {
    store: extended,
    specs: urlsync.config,
    apply: urlsync.apply,
    qualified: qualify(store.$id, urlsync.config),
  };
  registry.set(store.$id, entry);

  void router.isReady().then(() => hydrate(entry, router));

  // Watch the synced values rather than $subscribe: guarded keys are exposed
  // as computeds over private refs, and a private ref is not part of $state, so
  // $subscribe never sees an activation or layer change. Watching the schema's
  // own keys also means state that is deliberately not synced — catalogRevision,
  // pickMode — cannot reach the url at all.
  watch(
    () => entry.specs.map((spec) => extended[spec.name]),
    () => {
      if (entry.defaults === undefined) {
        return;
      }
      writeQuery(router, "push");
    },
    { deep: true },
  );
}

export default createUrlSync;

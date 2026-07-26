// Keeps the url in step with the stores that opt in via their `urlsync`
// option. All the encoding lives in ./urlCodec; this module is the adapter
// that owns the impure parts — reading location.search, waiting for the
// router, and writing history.
//
// The contract is docs/adr/0001-url-parameter-specification.md.

import type { PiniaPluginContext, Store as PiniaStore } from "pinia";
import type { Router } from "vue-router";

import { decode, encode, type FieldSpec } from "./urlCodec";

export type { FieldKind, FieldSpec } from "./urlCodec";

interface UrlSyncConfig {
  enabled?: boolean;
  config: FieldSpec[];
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
  // Store keys are qualified with the store id so two stores can use the same
  // key name without colliding in the shared rebuild below.
  qualified: FieldSpec[];
  // Preset-merged values, captured at hydration. Undefined until then, which
  // is also how we know this store's parameters must not be rewritten yet.
  defaults?: Record<string, unknown>;
}

// Every synced store, so one write can rebuild the whole query. Without this
// the url is an integration channel between stores, each preserving the
// other's parameters by reading them back out of location.search.
const registry = new Map<string, Registration>();

const paramOf = (spec: FieldSpec) => spec.url ?? spec.name;
const qualify = (storeId: string, specs: FieldSpec[]): FieldSpec[] => specs.map((spec) => ({ ...spec, name: `${storeId}.${spec.name}` }));

function currentQuery(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

// Rebuild the entire query from every hydrated store. Parameters belonging to
// stores that have not hydrated yet are treated as foreign and preserved, so a
// store that is created late cannot have its url read out from under it.
function writeQuery(history: "push" | "replace"): void {
  const hydrated = [...registry.values()].filter((entry) => entry.defaults !== undefined);
  if (hydrated.length === 0) {
    return;
  }

  const owned = new Set(hydrated.flatMap((entry) => entry.specs.map(paramOf)));
  const foreign = Object.fromEntries(Object.entries(currentQuery()).filter(([param]) => !owned.has(param)));

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
  // history entry — catalogRevision and pickMode both fire $subscribe.
  if (next === window.location.search) {
    return;
  }
  const url = next === "" ? window.location.pathname : next;
  if (history === "replace") {
    window.history.replaceState({}, "", url);
  } else {
    window.history.pushState({}, "", url);
  }
}

function hydrate(entry: Registration): void {
  const { store, specs } = entry;

  // The preset supplies this route's defaults, so it is applied before the
  // defaults are captured and before the url is read.
  const preset = store.customConfig[store.$id];
  if (preset) {
    for (const [key, value] of Object.entries(preset)) {
      store[key] = value;
    }
  }

  const defaults: Record<string, unknown> = {};
  for (const [index, spec] of specs.entries()) {
    defaults[entry.qualified[index]!.name] = store[spec.name];
  }
  entry.defaults = defaults;

  const { patch, invalid } = decode(currentQuery(), entry.qualified, defaults);
  for (const [index, spec] of specs.entries()) {
    store[spec.name] = patch[entry.qualified[index]!.name];
  }
  for (const param of invalid) {
    console.warn(`Ignoring invalid url parameter: ${param}`);
  }

  // Normalise the url to what the state actually is — dropping anything
  // invalid and anything that turned out to equal a default. Replace rather
  // than push: arriving at a page is not a state change.
  writeQuery("replace");
}

function createUrlSync({ options, store }: PiniaPluginContext): void {
  const urlsync = options.urlsync;
  if (!urlsync?.enabled && !urlsync?.config) {
    return;
  }

  const extended = store as unknown as ExtendedStore;
  const entry: Registration = {
    store: extended,
    specs: urlsync.config,
    qualified: qualify(store.$id, urlsync.config),
  };
  registry.set(store.$id, entry);

  void extended.router.isReady().then(() => hydrate(entry));

  store.$subscribe(() => {
    if (entry.defaults === undefined) {
      return;
    }
    writeQuery("push");
  });
}

export default createUrlSync;

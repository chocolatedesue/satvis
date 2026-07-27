// The adapter's own seam: what reaches the router's query, given store state.
// Foreign-parameter handling lives here rather than in the codec because only
// the router's LocationQuery can express a valueless or repeated parameter.
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp, markRaw } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

import { useCesiumStore } from "../../stores/cesium";
import { useSatStore } from "../../stores/sat";
import piniaUrlSync from "./urlSync";

// Writes reach the url through router.push/replace, which are async.
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function mount(initial: string): Promise<{ router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: {} }] });
  const pinia = createPinia();
  pinia.use(({ store }) => {
    store.router = markRaw(router);
    store.customConfig = markRaw({});
  });
  pinia.use(piniaUrlSync);
  createApp({}).use(pinia);
  setActivePinia(pinia);

  await router.replace(initial);
  useSatStore();
  useCesiumStore();
  await router.isReady();
  await flush();
  return { router };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("foreign parameters", () => {
  test("a valueless parameter survives a rebuild", async () => {
    const { router } = await mount("/?embed&tags=Weather");
    useSatStore().setActivation({ enabledTags: ["GNSS"] });
    await flush();
    expect("embed" in router.currentRoute.value.query).toBe(true);
    expect(router.currentRoute.value.query.tags).toBe("GNSS");
  });

  test("a repeated parameter keeps every value", async () => {
    const { router } = await mount("/?utm=a&utm=b");
    useSatStore().setActivation({ enabledTags: ["GNSS"] });
    await flush();
    expect(router.currentRoute.value.query.utm).toEqual(["a", "b"]);
  });

  test("an ordinary foreign parameter is untouched", async () => {
    const { router } = await mount("/?utm_source=x");
    useSatStore().setActivation({ enabledTags: ["GNSS"] });
    await flush();
    expect(router.currentRoute.value.query.utm_source).toBe("x");
  });
});

describe("owned parameters", () => {
  test("an invalid value is dropped and the state keeps its default", async () => {
    const { router } = await mount("/?terrain=Garbage");
    expect(useCesiumStore().terrainProvider).toBe("None");
    expect("terrain" in router.currentRoute.value.query).toBe(false);
  });

  test("state that is not synced never reaches the url", async () => {
    const { router } = await mount("/");
    const before = router.currentRoute.value.fullPath;
    useCesiumStore().pickMode = true;
    useSatStore().catalogRevision += 1;
    await flush();
    expect(router.currentRoute.value.fullPath).toBe(before);
  });
});

// The adapter's own seam: what reaches the router's query, given store state.
// Foreign-parameter handling lives here rather than in the codec because only
// the router's LocationQuery can express a valueless or repeated parameter.
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp, markRaw } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

import { useCesiumStore } from "../../stores/cesium";
import { useSatStore } from "../../stores/sat";
import piniaUrlSync, { whenHydrated } from "./urlSync";

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

  // The one selection that can be armed for a view mode the url is not also
  // asking for, so it has to survive being currently inapplicable.
  test("a surface model that cannot apply here is still carried", async () => {
    const { router } = await mount("/?surface=GooglePhotorealistic");
    expect(useCesiumStore().surfaceModel).toBe("GooglePhotorealistic");
    expect(router.currentRoute.value.query.surface).toBe("GooglePhotorealistic");
  });

  test("an invalid surface model is dropped and the state keeps its default", async () => {
    const { router } = await mount("/?surface=Bogus");
    expect(useCesiumStore().surfaceModel).toBe("None");
    expect("surface" in router.currentRoute.value.query).toBe(false);
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

// What `?demo=` depends on. A demo scene is store state applied by the app itself
// rather than by a user, so it races the one writer that also acts unprompted:
// hydration, which applies the route's preset and then the query. These pin the
// order, because getting it wrong does not fail loudly — it half-applies the
// scene, leaving everything the preset does not name in place.
describe("hydration ordering", () => {
  // Mount without waiting for hydration, so a caller can write in the window
  // between the app mounting and the url being read.
  function mountUnhydrated(initial: string, preset: Record<string, Record<string, unknown>> = {}): Router {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: {} }] });
    const pinia = createPinia();
    pinia.use(({ store }) => {
      store.router = markRaw(router);
      store.customConfig = markRaw(preset);
    });
    pinia.use(piniaUrlSync);
    createApp({}).use(pinia);
    setActivePinia(pinia);
    void router.replace(initial);
    useSatStore();
    useCesiumStore();
    return router;
  }

  // The `?demo=migration` bug, as a test: the default route's preset names
  // `enabledTags`, so a scene applied before the url is read loses exactly its
  // activation and keeps everything else — which is why the demo opened with the
  // weather group active and the pipeline placed on geostationary satellites.
  test("a scene applied before hydration loses the keys the preset names", async () => {
    mountUnhydrated("/?demo=migration", { sat: { enabledTags: ["Weather"] } });
    const satStore = useSatStore();
    satStore.setActivation({ enabledTags: ["Walker 53:20/2/1@550~180"] });
    satStore.walker = ["53:20/2/1@550~180"];
    await flush();
    expect(satStore.enabledTags).toEqual(["Weather"]);
    // The half-applied half: the preset does not name `walker`, so it survives —
    // the pattern is in the form while none of its satellites are switched on.
    expect(satStore.walker).toEqual(["53:20/2/1@550~180"]);
  });

  test("whenHydrated defers a scene until the preset and the url have been read", async () => {
    const router = mountUnhydrated("/?demo=migration", { sat: { enabledTags: ["Weather"] } });
    const satStore = useSatStore();
    await whenHydrated();
    satStore.setActivation({ enabledTags: ["Walker 53:20/2/1@550~180"] });
    satStore.walker = ["53:20/2/1@550~180"];
    await flush();
    expect(satStore.enabledTags).toEqual(["Walker 53:20/2/1@550~180"]);
    expect(satStore.walker).toEqual(["53:20/2/1@550~180"]);
    // And the scene round-trips to the url, so the address bar describes what is
    // on screen rather than only the shorthand that asked for it.
    expect(router.currentRoute.value.query.tags).toBe("Walker 53:20/2/1@550~180");
    expect(router.currentRoute.value.query.walker).toBe("53:20/2/1@550~180");
  });

  test("whenHydrated covers a store created before the call, not only the first one", async () => {
    const router = mountUnhydrated("/", {});
    await whenHydrated();
    // Hydration is what captures the defaults a write is compared against; a
    // store still unhydrated would refuse to write to the url at all.
    useCesiumStore().cameraMode = "Inertial";
    await flush();
    expect(router.currentRoute.value.query.camera).toBe("Inertial");
  });
});

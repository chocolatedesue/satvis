import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const emptyAssets = path.join(path.dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "empty-assets");

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Ephemeral in-memory KV for tests (do not touch remote/local data).
          kvNamespaces: ["GP_KV"],
          // Point the assets binding at an empty dir so the pool does not walk
          // the real ../dist build (which may contain large local-only model
          // assets exceeding the Workers asset size limit).
          assets: { directory: emptyAssets },
        },
      },
    },
  },
});

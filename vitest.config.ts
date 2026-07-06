import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Modules under test are Cesium-free; run in the node environment.
    environment: "node",
    include: ["src/test/**/*.test.ts"],
  },
});

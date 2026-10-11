import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@chromeuse/shared/v2": fileURLToPath(new URL("../shared/src/v2.ts", import.meta.url)),
      "@chromeuse/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
  },
});

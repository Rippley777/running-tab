import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: { include: ["server/domain/**"] },
  },
});

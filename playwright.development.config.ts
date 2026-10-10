import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "development.spec.ts",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:3141",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node --env-file=.env --import tsx tests/e2e/serve-development.ts",
    url: "http://localhost:3141/api/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: "list",
});

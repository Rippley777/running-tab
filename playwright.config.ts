import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: "development.spec.ts", // Isolated fixture server uses its own config.
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    actionTimeout: 15000,
    baseURL: "http://localhost:1420",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420/api/health",
    reuseExistingServer: true,
    timeout: 30000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});

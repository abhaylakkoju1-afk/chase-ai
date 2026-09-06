// Minimal Playwright configuration for the Chase AI shell smoke tests.
//
// This drives a real, headless Chromium browser against the existing
// static site (index.html) served locally over http://, never file://
// — the Firebase bootstrap script is `type="module"` and imports from
// gstatic.com, and module-script loading from a file:// origin is a
// well-known source of avoidable browser flakiness.
//
// This is test-time infrastructure only. It does not change how GitHub
// Pages serves the production site.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.spec.js",

  // Each test gets its own browser context (Playwright's default), so
  // localStorage never leaks between tests.
  fullyParallel: true,

  webServer: {
    command: "node test/e2e/static-server.js",
    url: "http://127.0.0.1:4173/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  use: {
    baseURL: "http://127.0.0.1:4173",
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});

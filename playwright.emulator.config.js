// Browser tests for accounts and sync against the Firebase Emulator Suite.
// Run with `npm run test:e2e:emulator` (starts the Auth + Database emulators
// under the demo-swimtics project, which cannot reach any real Firebase project).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e-emulator",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,               // tests share one emulator; keep them sequential

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
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});

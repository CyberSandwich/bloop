import { defineConfig } from "@playwright/test";

// CI only: headless Chrome cannot start in the local sandbox.
export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://127.0.0.1:8787", trace: "retain-on-failure" },
  webServer: {
    // TEST_TIMING skips the platform rate limits, which a suite creating many screens a minute would trip.
    // Every browser shares one IP hash, so the per-IP demo cap (DEMO-02) would refuse the third demo screen, and a
    // closed context leaves its demo screen alive, so the suite (and its retries) can pass the global cap too.
    // `predev` applies migrations/ to the local D1 first: without the tables every guest drop fails.
    command: "npm run dev -- --var TEST_TIMING:1 --var DEMO_MAX_PER_IP:1000 --var DEMO_MAX_CONCURRENT:1000",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

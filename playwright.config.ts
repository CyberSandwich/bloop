import { defineConfig } from "@playwright/test";
import type { Mode } from "./test/e2e/mode.ts";

// CI only: headless Chrome cannot start in the local sandbox.
export default defineConfig<{ mode: Mode }>({
  testDir: "test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // localhost, not 127.0.0.1: WebAuthn refuses an IP address as its relying party, so passkey flows need a name.
  use: { baseURL: "http://localhost:8787", trace: "retain-on-failure" },
  // The server's launch mode is one shared row, so the projects run in turn: preview, then open (flipped by
  // open-setup, put back by its teardown). Only the landing's open variants and the mode-aware specs run in open.
  projects: [{ name: "preview", testMatch: /upload-shots/ }],
  webServer: {
    // TEST_TIMING skips the platform rate limits, which a suite creating many screens a minute would trip.
    // Every browser shares one IP hash, so the per-IP demo cap (DEMO-02) would refuse the third demo screen, and a
    // closed context leaves its demo screen alive, so the suite (and its retries) can pass the global cap too.
    // `predev` applies migrations/ to the local D1 first: without the tables every guest drop fails.
    // DEV_MAILBOX keeps mail in memory; UPLOAD_MODE and CONVERT_MODE keep the tests off R2's
    // network endpoint and off the container.
    command:
      "npm run dev -- --var TEST_TIMING:1 --var DEMO_MAX_PER_IP:1000 --var DEMO_MAX_CONCURRENT:1000 --var DEV_MAILBOX:1 --var UPLOAD_MODE:proxy --var UPLOAD_PART_BYTES:5242880 --var LIBRARY_MAX_FILE_BYTES:536870912 --var CONVERT_MODE:stub",
    url: "http://localhost:8787/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

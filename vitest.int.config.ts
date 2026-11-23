import { defineConfig } from "vitest/config";

// Each file starts its own wrangler dev (test/integration/wrangler.ts), so files run one at a time.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

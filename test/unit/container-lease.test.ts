import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The longest a conversion lease may be asked for is CAP_LEASE_CONVERT_SECONDS (src/worker/spend/caps.ts). Every kind of
 * conversion job must finish inside it: its stage timeouts (container/main.go), summed in the order the pipeline runs
 * them, plus a fixed allowance for the upload and the downloads, which this test cannot measure. It runs in the unit
 * suite so a change to either side alone is caught.
 */
const TRANSFERS = 300;
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const lease = Number(
  /lease_max_convert_seconds: \{[^}]*default: (\d+)/s.exec(read("../../src/worker/spend/caps.ts"))?.[1],
);
const stages: Record<string, number> = Object.fromEntries(
  [...read("../../container/main.go").matchAll(/"(\w+)":\s+(\d+) \* time\.Second/g)].map(([, name, secs]) => [
    name,
    Number(secs),
  ]),
);

// documentJob: inspect, convert, the pptx pass for ppt, pps and odp, the font lookup (inspect's timeout), rasterize.
const CHAINS: Record<string, string[]> = {
  document: ["inspect", "convert", "convert", "inspect", "rasterize"],
  video: ["inspect", "video"],
  image: ["inspect", "heic"],
};

describe("the converter's stage timeouts fit the conversion lease", () => {
  it("reads the lease and every stage default", () => {
    expect(lease).toBeGreaterThan(0);
    for (const stage of ["inspect", "convert", "rasterize", "video", "heic"]) {
      expect(stages[stage], stage).toBeGreaterThan(0);
    }
  });

  for (const [kind, chain] of Object.entries(CHAINS)) {
    it(`${kind}: its stage timeouts and the transfer allowance stay within the lease`, () => {
      const total = chain.reduce((sum, stage) => sum + (stages[stage] ?? 0), 0) + TRANSFERS;
      expect(total, `${kind} adds to ${total} s against a ${lease} s lease`).toBeLessThanOrEqual(lease);
    });
  }
});

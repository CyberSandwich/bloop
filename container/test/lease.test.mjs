// The longest a conversion lease may be asked for is CAP_LEASE_CONVERT_SECONDS (src/worker/spend/caps.ts). Every kind of
// job must finish inside it: its stage timeouts, summed in the order the pipeline runs them, plus a fixed allowance for
// the upload and the downloads, which this test cannot measure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const TRANSFERS = 300;
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const lease = Number(
  /lease_max_convert_seconds: \{[^}]*default: (\d+)/s.exec(read("../../src/worker/spend/caps.ts"))?.[1],
);
const stages = Object.fromEntries(
  [...read("../main.go").matchAll(/"(\w+)":\s+(\d+) \* time\.Second/g)].map(([, name, secs]) => [name, Number(secs)]),
);

// documentJob: inspect, convert, the pptx pass for ppt, pps and odp, the font lookup (inspect's timeout), rasterize.
const CHAINS = {
  document: ["inspect", "convert", "convert", "inspect", "rasterize"],
  video: ["inspect", "video"],
  image: ["inspect", "heic"],
};

test("the stage defaults and the lease were read", () => {
  assert.ok(lease > 0, `lease ${lease}`);
  for (const stage of ["inspect", "convert", "rasterize", "video", "heic"])
    assert.ok(stages[stage] > 0, `stage ${stage}`);
});

for (const [kind, chain] of Object.entries(CHAINS)) {
  test(`${kind}: its stage timeouts and the transfer allowance fit the conversion lease`, () => {
    const total = chain.reduce((sum, stage) => sum + stages[stage], 0) + TRANSFERS;
    assert.ok(total <= lease, `${kind} adds to ${total} s, over the ${lease} s lease`);
  });
}

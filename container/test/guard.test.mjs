// A shared CI runner's speed varies by 25 percent or more, so no corpus check may pass or fail on elapsed
// time. Timings are recorded to the job summary (`timings`); the properties asserted are that a job finishes
// under its stage timeout and that its outputs validate.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const corpusFiles = readdirSync(dir).filter((f) => /^(cases|corpus|lib|macros)\.mjs$/.test(f));

test("no corpus check compares elapsed time", () => {
  assert.ok(corpusFiles.length === 4, `found ${corpusFiles}`);
  const offenders = [];
  for (const f of corpusFiles) {
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/\bcheck\(/.test(line) && /(\.ms\b|stageDurations|stageAt|Date\.now\(\))/.test(line))
          offenders.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(offenders, [], "a check() compares wall-clock time; record it with timings.push instead");
});

test("the guard catches a check on elapsed time", () => {
  const line = "check(r.ms < 5000, 'fast enough');";
  assert.ok(/\bcheck\(/.test(line) && /(\.ms\b|stageDurations|stageAt|Date\.now\(\))/.test(line));
});

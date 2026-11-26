// A shared CI runner's speed varies by 25 percent or more, so no corpus check may pass or fail on elapsed
// time. runJob hands checks a result with no timing; timings are recorded to the job summary (`timings`) and
// the properties asserted are that a job finishes under its stage timeout and that its outputs validate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recordTiming, splitTiming, timingOf } from "./result.mjs";

test("a job result carries no timing, and the timing is still reachable on its own", () => {
  const raw = { status: { state: "done" }, ms: 1234, early: null, stageAt: { convert: 5 }, files: {}, manifest: null };
  const { result, timing } = splitTiming(raw);
  for (const key of ["ms", "stageAt"]) assert.ok(!(key in result), `result has ${key}`);
  assert.deepEqual(Object.keys(result).sort(), ["early", "files", "manifest", "status"]);
  assert.equal(recordTiming(result, timing), result);
  assert.deepEqual(timingOf(result), { ms: 1234, stageAt: { convert: 5 } });
  assert.equal(timingOf({}), undefined);
});

test("runJob builds its result through splitTiming", () => {
  const lib = readFileSync(new URL("./lib.mjs", import.meta.url), "utf8");
  const runJob = lib.slice(
    lib.indexOf("export async function runJob"),
    lib.indexOf("export function expectDeckOutputs"),
  );
  assert.match(runJob, /splitTiming\(/);
  assert.doesNotMatch(runJob, /out\.(ms|stageAt)\b/);
});

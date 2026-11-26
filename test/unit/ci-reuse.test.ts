import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_JOB,
  CI_PATH,
  checkJobId,
  DIGEST_STEP,
  digestFrom,
  digestLine,
  manifestDigest,
  matchingRun,
  outcome,
} from "../../tools/ci-reuse.mjs";
import { filesOf, MANIFEST, manifestProblems } from "../../tools/prebuilt.mjs";

const SHA = "a".repeat(40);
const REPO = "owner/bloop";
const run = (over: Record<string, unknown> = {}) => ({
  id: 7,
  head_sha: SHA,
  event: "push",
  status: "completed",
  conclusion: "success",
  path: CI_PATH,
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  ...over,
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  needs?: string | string[];
  "continue-on-error"?: boolean;
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
/** A GitHub Actions expression, built so no string literal holds `${`. */
const expr = (inner: string) => `$${"{{"} ${inner} }}`;

const deploy = load(readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8")) as {
  jobs: Record<string, Job>;
};

describe("SITE-05 deploy reuse: where dist/ came from", () => {
  it("SITE-05 deploy reuse: a push run of this repo's ci.yml that passed this exact sha matches, the newest first", () => {
    expect(matchingRun([run({ id: 3 }), run({ id: 9 }), run({ id: 5 })], { sha: SHA, repo: REPO })?.id).toBe(9);
  });

  it("SITE-05 deploy reuse: another sha, event, workflow, repository, fork head, status or conclusion never matches", () => {
    const refused = [
      run({ head_sha: "b".repeat(40) }),
      run({ event: "pull_request" }),
      run({ event: "workflow_dispatch" }),
      run({ path: ".github/workflows/shots.yml" }),
      run({ repository: { full_name: "other/bloop" } }),
      run({ head_repository: { full_name: "fork/bloop" } }),
      run({ head_repository: null }),
      run({ status: "in_progress", conclusion: null }),
      run({ conclusion: "failure" }),
      run({ conclusion: "cancelled" }),
    ];
    for (const r of refused) expect(matchingRun([r], { sha: SHA, repo: REPO }), JSON.stringify(r)).toBeUndefined();
    expect(matchingRun([], { sha: SHA, repo: REPO })).toBeUndefined();
  });
});

describe("SITE-05 deploy reuse: the artifact is intact", () => {
  it("SITE-05 deploy reuse: a dist/ with a tampered manifest is refused even when the run matches", () => {
    expect(matchingRun([run()], { sha: SHA, repo: REPO })).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "ci-reuse-"));
    roots.push(dir);
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    writeFileSync(join(dir, MANIFEST), JSON.stringify({ ...filesOf(dir), "index.html": "0".repeat(64) }));
    expect(manifestProblems(dir)).toEqual(["index.html changed"]);
    // The assert step failing leaves the upload skipped, and only an uploaded dist/ is reused.
    expect(outcome("7", "skipped", "https://github.com", REPO).reused).toBe(false);
  });

  it("SITE-05 deploy reuse: reused only when a run matched and its dist/ was uploaded; the summary names the path", () => {
    expect(outcome("7", "success", "https://github.com", REPO)).toEqual({
      reused: true,
      line: `Reused dist/ from ci run https://github.com/${REPO}/actions/runs/7; the check job is skipped.`,
    });
    expect(outcome("", "", "https://github.com", REPO)).toEqual({
      reused: false,
      line: "Full check: no ci run matched with its check job's digest.",
    });
    expect(outcome("7", "failure", "https://github.com", REPO).reused).toBe(false);
    expect(outcome("7\nreused=true", "success", "https://github.com", REPO).reused).toBe(false);
  });
});

describe("SITE-05 deploy reuse: deploy.yml wiring", () => {
  const { reuse, check, deploy: ship } = deploy.jobs;
  const step = (id: string) => reuse?.steps.find((s) => s.id === id);

  it("SITE-05 deploy reuse: the reuse job holds no secret, no environment and reads only contents and actions", () => {
    const text = JSON.stringify(reuse);
    expect(text).not.toMatch(/secrets|environment|CLOUDFLARE/i);
    expect(reuse?.permissions).toEqual({ contents: "read", actions: "read" });
    expect(reuse?.steps.some((s) => /\bnpm\b|npx/.test(s.run ?? ""))).toBe(false);
  });

  it("SITE-05 deploy reuse: each step after the match runs only on the one before succeeding, and reused comes from done", () => {
    expect(step("get")?.if).toBe("steps.find.outputs.run_id != ''");
    expect(step("get")?.with?.["run-id"]).toBe(expr("steps.find.outputs.run_id"));
    expect(step("assert")?.if).toBe("steps.get.outcome == 'success'");
    expect(step("assert")?.run).toBe("node tools/prebuilt.mjs assert");
    expect(step("verify")?.if).toBe("steps.assert.outcome == 'success'");
    expect(step("verify")?.run).toBe("node tools/ci-reuse.mjs verify");
    expect(step("verify")?.env?.EXPECT).toBe(expr("steps.find.outputs.manifest_sha256"));
    expect(step("put")?.if).toBe("steps.verify.outcome == 'success'");
    expect(step("done")?.env?.PUT).toBe(expr("steps.put.outcome"));
    expect(reuse?.outputs).toEqual({ reused: expr("steps.done.outputs.reused") });
  });

  it("SITE-05 deploy reuse: check runs unless reuse said reused, and deploy needs a passed check or a reused dist/", () => {
    expect(check?.needs).toBe("reuse");
    // success() is false once a needed job is skipped, which would skip deploy on every reuse and still look green.
    for (const job of [check, ship]) expect(job?.if).not.toMatch(/success\(\)|failure\(\)|always\(\)/);
    expect(reuse?.["continue-on-error"]).toBe(true);
    expect(check?.if).toBe("cancelled() == false && needs.reuse.outputs.reused != 'true'");
    expect(ship?.needs).toEqual(["reuse", "check"]);
    expect(ship?.if).toBe(
      "cancelled() == false && (needs.check.result == 'success' || (needs.check.result == 'skipped' && needs.reuse.outputs.reused == 'true'))",
    );
  });
});

const ciText = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const ci = load(ciText) as { jobs: Record<string, Job> };
const job = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: CHECK_JOB,
  conclusion: "success",
  steps: [{ name: DIGEST_STEP, conclusion: "success" }],
  ...over,
});

describe("SITE-05 deploy reuse: the check job's own log names the digest", () => {
  it("SITE-05 deploy reuse: only one passed check job whose digest step passed is read", () => {
    expect(checkJobId([job(4), { id: 5, name: "browser", conclusion: "success" }])).toBe(4);
    expect(checkJobId([job(4, { conclusion: "failure" })])).toBeUndefined();
    expect(checkJobId([job(4, { steps: [{ name: DIGEST_STEP, conclusion: "skipped" }] })])).toBeUndefined();
    expect(checkJobId([job(4, { steps: [{ name: "other", conclusion: "success" }] })])).toBeUndefined();
    expect(checkJobId([job(4), job(6)])).toBeUndefined();
    expect(checkJobId([{ ...job(4), name: "browser" }])).toBeUndefined();
  });

  it("SITE-05 deploy reuse: the log must name exactly one digest, timestamped or not", () => {
    const hex = "b".repeat(64);
    expect(digestFrom(`2026-11-26T14:53:19.80Z ##[group]Run x\n2026-11-26T14:53:19.81Z ${digestLine(hex)}\n`)).toBe(
      hex,
    );
    expect(digestFrom(`${digestLine(hex)}\r\n`)).toBe(hex);
    expect(digestFrom("no digest here\n")).toBeUndefined();
    expect(digestFrom(`${digestLine(hex)}\n${digestLine("c".repeat(64))}\n`)).toBeUndefined();
    expect(digestFrom(`echo ${digestLine(hex)}\n`)).toBeUndefined();
    expect(digestFrom(digestLine("B".repeat(64)))).toBeUndefined();
  });

  it("SITE-05 deploy reuse: a dist/ whose manifest differs from the logged digest is refused, even when it asserts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-reuse-"));
    roots.push(dir);
    writeFileSync(join(dir, "index.html"), "<p>hi</p>");
    writeFileSync(join(dir, MANIFEST), JSON.stringify(filesOf(dir)));
    expect(manifestProblems(dir)).toEqual([]);
    const logged = manifestDigest(dir);
    writeFileSync(join(dir, "index.html"), "<p>swapped</p>");
    writeFileSync(join(dir, MANIFEST), JSON.stringify(filesOf(dir)));
    expect(manifestProblems(dir)).toEqual([]);
    expect(manifestDigest(dir)).not.toBe(logged);
  });

  it("SITE-05 deploy reuse: ci.yml's check installs without scripts and logs the digest; browser never touches dist/", () => {
    const check = ci.jobs.check?.steps ?? [];
    expect(check.some((s) => s.run === "npm ci --ignore-scripts")).toBe(true);
    expect(check.some((s) => /^npm ci\s*$/.test(s.run ?? ""))).toBe(false);
    const at = (pred: (s: Step) => boolean) => check.findIndex(pred);
    const digest = at((s) => (s as { name?: string }).name === DIGEST_STEP);
    expect(check[digest]?.run).toBe("node tools/ci-reuse.mjs digest");
    expect(digest).toBeGreaterThan(at((s) => s.run === "node tools/prebuilt.mjs manifest"));
    expect(JSON.stringify(ci.jobs.browser)).not.toMatch(/\bdist\b/);
    const uploads = Object.values(ci.jobs).flatMap((j) =>
      j.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact") && s.with?.name === "dist"),
    );
    expect(uploads).toHaveLength(1);
  });
});

type Ctx = { cancelled: boolean; reuse: string; reused: string; check?: string };
/** Evaluates the two job conditions the way Actions does for these operators: only ==, !=, &&, ||, parentheses,
 * string literals, cancelled() and needs.<job>.result / .outputs.reused. Anything else throws. */
function evaluate(expr: string, ctx: Ctx): boolean {
  const js = expr
    .replaceAll("cancelled()", String(ctx.cancelled))
    .replaceAll("needs.reuse.outputs.reused", JSON.stringify(ctx.reused))
    .replaceAll("needs.reuse.result", JSON.stringify(ctx.reuse))
    .replaceAll("needs.check.result", JSON.stringify(ctx.check ?? ""))
    .replaceAll("'", '"')
    .replaceAll("!=", "<>")
    .replaceAll("==", "===")
    .replaceAll("<>", "!==");
  if (!/^(?:true|false|"[a-z]*"|[()&|=! ])+$/.test(js)) throw new Error(`unevaluated: ${js}`);
  return Function(`return (${js});`)() as boolean;
}

describe("SITE-05 deploy reuse: the conditions, evaluated", () => {
  const checkIf = deploy.jobs.check?.if ?? "";
  const shipIf = deploy.jobs.deploy?.if ?? "";
  /** check's result is what its own condition and its run decide; deploy's condition then reads it. */
  const path = (ctx: Omit<Ctx, "check">, checkRan: "success" | "failure") => {
    const check = evaluate(checkIf, ctx) ? checkRan : "skipped";
    return { check, deploy: evaluate(shipIf, { ...ctx, check }) };
  };

  it("SITE-05 deploy reuse: reused skips check and deploys; full runs check and deploys; a failed check never deploys", () => {
    expect(path({ cancelled: false, reuse: "success", reused: "true" }, "success")).toEqual({
      check: "skipped",
      deploy: true,
    });
    expect(path({ cancelled: false, reuse: "success", reused: "" }, "success")).toEqual({
      check: "success",
      deploy: true,
    });
    expect(path({ cancelled: false, reuse: "failure", reused: "" }, "success")).toEqual({
      check: "success",
      deploy: true,
    });
    expect(path({ cancelled: false, reuse: "success", reused: "" }, "failure")).toEqual({
      check: "failure",
      deploy: false,
    });
    expect(path({ cancelled: false, reuse: "failure", reused: "" }, "failure")).toEqual({
      check: "failure",
      deploy: false,
    });
  });

  it("SITE-05 deploy reuse: a cancelled run neither checks nor deploys, and a skipped check without reuse never deploys", () => {
    expect(path({ cancelled: true, reuse: "success", reused: "true" }, "success")).toEqual({
      check: "skipped",
      deploy: false,
    });
    expect(path({ cancelled: true, reuse: "cancelled", reused: "" }, "success")).toEqual({
      check: "skipped",
      deploy: false,
    });
    expect(evaluate(shipIf, { cancelled: false, reuse: "success", reused: "", check: "skipped" })).toBe(false);
    expect(evaluate(shipIf, { cancelled: false, reuse: "success", reused: "false", check: "skipped" })).toBe(false);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { CI_PATH, matchingRun, outcome } from "../../tools/ci-reuse.mjs";
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
      line: "Full check: no ci run matched.",
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
    expect(step("put")?.if).toBe("steps.assert.outcome == 'success'");
    expect(step("done")?.env?.PUT).toBe(expr("steps.put.outcome"));
    expect(reuse?.outputs).toEqual({ reused: expr("steps.done.outputs.reused") });
  });

  it("SITE-05 deploy reuse: check runs unless reuse said reused, and deploy needs a passed check or a reused dist/", () => {
    expect(check?.needs).toBe("reuse");
    expect(check?.if).toBe("(success() || failure()) && needs.reuse.outputs.reused != 'true'");
    expect(ship?.needs).toEqual(["reuse", "check"]);
    expect(ship?.if).toBe(
      "(success() || failure()) && (needs.check.result == 'success' || (needs.check.result == 'skipped' && needs.reuse.outputs.reused == 'true'))",
    );
  });
});

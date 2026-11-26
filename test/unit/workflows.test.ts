import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withPrebuilt } from "../../tools/prebuilt.mjs";

const dir = new URL("../../.github/workflows/", import.meta.url);

/** Where a deploy secret is set: the line numbers of every `env:` block at workflow or job level that names it. */
function broadScopes(text: string, secret: string): number[] {
  const lines = text.split("\n");
  const found: number[] = [];
  lines.forEach((line, i) => {
    const env = /^( {0,4})env:\s*$/.exec(line);
    if (!env) return;
    const indent = (env[1] ?? "").length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
      if (next.includes(secret)) found.push(i + 1);
    }
  });
  return found;
}

/**
 * Every `lhci` command a workflow runs: a one-line `run:` as written (quotes dropped), and each line of a `run: |` or
 * `run: >` block, marked `inBlock` so the guard can refuse it (one command per step keeps the retry rule checkable).
 */
function lhciRuns(text: string): { run: string; inBlock: boolean }[] {
  const lines = text.split("\n");
  const found: { run: string; inBlock: boolean }[] = [];
  lines.forEach((line, i) => {
    const step = /^(\s*-?\s*)run:\s*(.*)$/.exec(line);
    if (!step) return;
    const value = (step[2] ?? "").trim();
    if (!/^[|>][-+]?$/.test(value)) {
      const run = value.replace(/^(["'])(.*)\1$/, "$2");
      if (/\blhci\b/.test(run)) found.push({ run, inBlock: false });
      return;
    }
    const indent = (step[1] ?? "").length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
      if (/\blhci\b/.test(next)) found.push({ run: next.trim(), inBlock: true });
    }
  });
  return found;
}

/** Why a workflow's Lighthouse steps break the rule: a tool error retried once, a page judgment never. */
function lhciProblems(text: string): string[] {
  const found = lhciRuns(text);
  if (found.length === 0) return [];
  const runs = found.map((f) => f.run);
  const problems: string[] = [];
  if (found.some((f) => f.inBlock)) problems.push("lhci runs inside a block step");
  if (runs.some((r) => r.includes("autorun"))) problems.push("autorun joins collect and assert in one try");
  if (!runs.includes("npx lhci collect || npx lhci collect")) problems.push("collect is not retried once");
  const asserts = runs.filter((r) => r.includes("lhci assert"));
  if (asserts.length !== 1 || asserts[0] !== "npx lhci assert") problems.push("assert must run once, unretried");
  return problems;
}

describe("Lighthouse steps", () => {
  it("Lighthouse: every workflow retries collect once and runs assert once", () => {
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    const withLhci = files.filter((f) => lhciRuns(readFileSync(new URL(f, dir), "utf8")).length > 0);
    expect(withLhci).toContain("ci.yml");
    for (const f of withLhci) expect(lhciProblems(readFileSync(new URL(f, dir), "utf8")), f).toEqual([]);
  });

  it("Lighthouse: the guard refuses autorun, an unretried collect and a retried assert", () => {
    expect(lhciProblems("      - run: npx lhci autorun\n")).toContain("autorun joins collect and assert in one try");
    expect(lhciProblems("      - run: npx lhci collect\n      - run: npx lhci assert\n")).toEqual([
      "collect is not retried once",
    ]);
    const retried =
      "      - run: npx lhci collect || npx lhci collect\n      - run: npx lhci assert || npx lhci assert\n";
    expect(lhciProblems(retried)).toEqual(["assert must run once, unretried"]);
    expect(lhciProblems("      - run: npm test\n")).toEqual([]);
  });

  it("Lighthouse: the guard sees lhci in a quoted step and in a `|` or `>` block step", () => {
    expect(lhciProblems('      - run: "npx lhci autorun"\n')).toContain("autorun joins collect and assert in one try");
    for (const style of ["|", ">", "|-"]) {
      const block = `      - run: ${style}\n          npm ci\n          npx lhci autorun\n      - run: npm test\n`;
      expect(lhciRuns(block), style).toEqual([{ run: "npx lhci autorun", inBlock: true }]);
      expect(lhciProblems(block), style).toContain("lhci runs inside a block step");
    }
    const good = "      - run: npx lhci collect || npx lhci collect\n      - run: npx lhci assert\n";
    expect(lhciProblems(`${good}      - run: |\n          npx lhci upload\n`)).toEqual([
      "lhci runs inside a block step",
    ]);
  });
});

describe("deploy.yml", () => {
  it("does not read R2: the deploy token has no R2 permission (SITE-05)", () => {
    expect(readFileSync(new URL("deploy.yml", dir), "utf8")).not.toMatch(/wrangler r2/);
  });
});

describe("SITE-05 deploy token scope", () => {
  it("SITE-05 token scope: no workflow sets CLOUDFLARE_API_TOKEN at workflow or job level", () => {
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(broadScopes(readFileSync(new URL(f, dir), "utf8"), "CLOUDFLARE_API_TOKEN"), f).toEqual([]);
    }
  });

  it("SITE-05 token scope: the guard sees a job-level and a workflow-level env, and passes a step-level one", () => {
    const job = "jobs:\n  deploy:\n    env:\n      CLOUDFLARE_API_TOKEN: x\n    steps:\n      - run: a\n";
    const flow = "env:\n  CLOUDFLARE_API_TOKEN: x\njobs:\n  deploy:\n    steps:\n      - run: a\n";
    const step = "jobs:\n  deploy:\n    steps:\n      - run: a\n        env:\n          CLOUDFLARE_API_TOKEN: x\n";
    expect(broadScopes(job, "CLOUDFLARE_API_TOKEN")).toEqual([3]);
    expect(broadScopes(flow, "CLOUDFLARE_API_TOKEN")).toEqual([1]);
    expect(broadScopes(step, "CLOUDFLARE_API_TOKEN")).toEqual([]);
  });
});

interface Job {
  name: string;
  text: string;
  environment: boolean;
  runs: string[];
  uses: string[];
  shells: string[];
}

/** Each job of a workflow: its text, whether it names an environment, and what its steps run and use. */
function jobsOf(workflow: string): Job[] {
  const lines = workflow.split("\n");
  const start = lines.indexOf("jobs:");
  const heads = lines.flatMap((line, i) => (i > start && /^ {2}[\w-]+:\s*$/.test(line) ? [i] : []));
  return heads.map((from, n) => {
    const body = lines.slice(from, heads[n + 1] ?? lines.length);
    const job: Job = {
      name: (body[0] ?? "").trim().slice(0, -1),
      text: body.join("\n"),
      environment: body.some((line) => /^ {4}environment:/.test(line)),
      runs: [],
      uses: [],
      shells: [],
    };
    body.forEach((line, i) => {
      const use = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (use) job.uses.push(use[1] ?? "");
      if (/^\s*-?\s*shell:/.test(line)) job.shells.push(line.trim());
      const step = /^(\s*-?\s*)run:\s*(.*)$/.exec(line);
      if (!step) return;
      const value = (step[2] ?? "").trim();
      if (!/^[|>][-+]?$/.test(value)) {
        job.runs.push(value);
        return;
      }
      const indent = (step[1] ?? "").length;
      for (let j = i + 1; j < body.length; j++) {
        const next = body[j] ?? "";
        if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
        if (next.trim() !== "") job.runs.push(next.trim());
      }
    });
    return job;
  });
}

/** What a job that holds the Cloudflare token may run: first-party tools with plain arguments, a scripted-free install. */
const TOKEN_RUN = /^(node tools\/(pinned-wrangler|staging|prebuilt)\.mjs( [\w.=-]+)*|npm ci --ignore-scripts)$/;
/** The token gates: a fixed test and echo, allowed whole because they hold a semicolon. */
const GATES = [
  'if [ -n "$CLOUDFLARE_API_TOKEN" ]; then echo "has=true" >> "$GITHUB_OUTPUT"; else echo "No CLOUDFLARE_API_TOKEN; skipping deploy."; fi',
  'if [ -n "$CLOUDFLARE_API_TOKEN" ]; then echo "has=true" >> "$GITHUB_OUTPUT"; else echo "Staging skipped: no CLOUDFLARE_API_TOKEN in the staging environment."; fi',
];
/** The actions a token job may use, by pinned commit: checkout, setup-node, download-artifact. */
const TOKEN_USES = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
  "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
];

/** Why a workflow's token jobs (any job naming an environment or CLOUDFLARE_API_TOKEN) could run third-party code. */
function tokenJobProblems(workflow: string): string[] {
  const problems: string[] = [];
  for (const job of jobsOf(workflow).filter((j) => j.environment || j.text.includes("CLOUDFLARE_API_TOKEN"))) {
    for (const run of job.runs)
      if (!TOKEN_RUN.test(run) && !GATES.includes(run)) problems.push(`${job.name}: run ${run}`);
    for (const use of job.uses) if (!TOKEN_USES.includes(use)) problems.push(`${job.name}: uses ${use}`);
    for (const shell of job.shells) problems.push(`${job.name}: ${shell}`);
  }
  return problems;
}

describe("SITE-05 third-party code never shares a job with the token", () => {
  const workflows = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, readFileSync(new URL(f, dir), "utf8")] as const);

  it("SITE-05 token jobs: every job that names an environment or the token runs only the allowed commands and actions", () => {
    let tokenJobs = 0;
    for (const [f, text] of workflows) {
      expect(tokenJobProblems(text), f).toEqual([]);
      tokenJobs += jobsOf(text).filter((j) => j.environment || j.text.includes("CLOUDFLARE_API_TOKEN")).length;
    }
    expect(tokenJobs).toBe(2);
  });

  it("SITE-05 token jobs: the check job has no environment and no secret, and hands dist/ over with its hidden files", () => {
    for (const f of ["deploy.yml", "staging.yml"]) {
      const text = readFileSync(new URL(f, dir), "utf8");
      const check = jobsOf(text).find((j) => j.name === "check");
      expect(check?.runs, f).toEqual(["npm ci --ignore-scripts", "npm run check", "node tools/prebuilt.mjs manifest"]);
      expect(check?.text, f).not.toMatch(/environment:|secrets\./);
      expect(check?.text, f).toContain("include-hidden-files: true");
      expect(text, f).toContain("needs: check");
      expect(text, f).not.toContain("cache: npm\n      - if");
    }
  });

  it("SITE-05 token jobs: the guard refuses each way to run other code in a token job", () => {
    const job = (steps: string, header = "    environment: production\n") =>
      `jobs:\n  deploy:\n${header}    steps:\n${steps}`;
    const bad = [
      "      - run: node tools/prebuilt.mjs rewrite && npx vitest\n",
      "      - run: node tools/staging.mjs deploy; curl example.test\n",
      "      - run: node tools/staging.mjs deploy | tee out\n",
      "      - run: node tools/staging.mjs `id`\n",
      "      - run: node tools/staging.mjs $(id)\n",
      '      - run: if [ -n "$CLOUDFLARE_API_TOKEN" ]; then npx x; fi\n',
      "      - run: npm run check\n",
      "      - uses: someone/action@v1\n",
      "      - uses: actions/checkout@v4\n",
      "      - run: node tools/staging.mjs ready\n        shell: npx foo {0}\n",
    ];
    for (const step of bad) expect(tokenJobProblems(job(step)), step).not.toEqual([]);
    // A job with no environment that reads the repository secret is a token job too.
    const noEnv =
      "jobs:\n  build:\n    steps:\n      - run: npm test\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.X }}\n";
    expect(tokenJobProblems(noEnv)).toEqual(["build: run npm test"]);
    expect(
      tokenJobProblems(job("      - run: node tools/pinned-wrangler.mjs d1 migrations apply DB --remote\n")),
    ).toEqual([]);
  });

  it("SITE-05 token jobs: wrangler.jsonc's build block is the one the deploy jobs know how to swap", () => {
    const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    expect(() => withPrebuilt(config)).not.toThrow();
    expect(withPrebuilt(config)).toContain("node tools/prebuilt.mjs assert");
    expect(() => withPrebuilt("{}")).toThrow(/no build block/);
  });
});

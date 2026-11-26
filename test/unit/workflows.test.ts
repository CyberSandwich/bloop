import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../../.github/workflows/", import.meta.url);

/** Where a deploy secret is set: the line numbers of every `env:` block at workflow or job level that names it. */
function broadScopes(text: string, secret: string): number[] {
  const lines = text.split("\n");
  const found: number[] = [];
  lines.forEach((line, i) => {
    const env = /^( {0,4})["']?env["']?\s*:(.*)$/.exec(line);
    if (!env) return;
    // A flow-style `env: { NAME: x }` holds its names on the key's own line.
    if ((env[2] ?? "").replace(/#.*/, "").includes(secret)) found.push(i + 1);
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
    const forms = [
      "jobs:\n  deploy:\n    env: # c\n      CLOUDFLARE_API_TOKEN: x\n",
      'jobs:\n  deploy:\n    "env":\n      CLOUDFLARE_API_TOKEN: x\n',
      "jobs:\n  deploy:\n    env: { CLOUDFLARE_API_TOKEN: x }\n",
    ];
    for (const form of forms) expect(broadScopes(form, "CLOUDFLARE_API_TOKEN"), form).toEqual([3]);
  });
});

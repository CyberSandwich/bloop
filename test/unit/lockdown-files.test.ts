import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { meterNames } from "../../tools/lockdown.mjs";
import { table } from "./lockdown-fakes";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const LEVELS = ["L1", "L2", "L3", "L4", "L5"];

describe("lockdown.yml matches the table", () => {
  const yml = read(".github/workflows/lockdown.yml");
  const optionsOf = (input: string) => {
    const block = yml.split(new RegExp(`^      ${input}:\\n`, "m"))[1]?.split(/^ {6}\w+:\n/m)[0] ?? "";
    const list = block.split(/^ {8}options:\n/m)[1] ?? "";
    return [...list.matchAll(/^ {10}- (\S+)$/gm)].map((m) => m[1]);
  };
  const [head = "", ...rest] = yml.split(/^ {6}- name: Plan or apply\n/m);
  const applyStep = rest.join("").split(/^ {6}- name: Summary\n/m)[0] ?? "";

  it("offers L1 to L5 and exactly the meters the table lists, plus none", () => {
    expect(optionsOf("level")).toEqual(LEVELS);
    expect(optionsOf("meter")).toEqual(["none", ...meterNames(table)]);
  });

  it("has boolean undo and apply, and both default to false", () => {
    for (const input of ["undo", "apply"]) {
      const block = yml.split(new RegExp(`^      ${input}:\\n`, "m"))[1]?.split(/^ {6}\w+:\n|^\S/m)[0] ?? "";
      expect(block, input).toContain("type: boolean");
      expect(block, input).toMatch(/default: false/);
    }
  });

  it("is dispatch only and scoped to actions write", () => {
    expect(yml).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(yml).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n {2}actions: write\n/m);
    expect(yml).toContain("environment: production");
  });

  it("runs only from main and only for the repository owner, with no login written in", () => {
    expect(yml).toContain("if: github.ref == 'refs/heads/main' && github.triggering_actor == github.repository_owner");
    expect(yml).not.toMatch(/triggering_actor == ['"]/);
    expect(yml).not.toMatch(/CyberSandwich/i);
    // No step re-gates by undo or apply: the owner check holds on every run.
    expect(yml.match(/triggering_actor/g)).toHaveLength(1);
  });

  it("holds the secrets in the apply step's env only, and installs without scripts", () => {
    expect(head).not.toContain("secrets.");
    expect(applyStep).toContain("secrets.LOCKDOWN_CF_TOKEN");
    expect(applyStep).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(applyStep).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(applyStep).toContain("secrets.GITHUB_TOKEN");
    expect(yml).toContain("- run: npm ci --ignore-scripts");
    expect(yml).not.toMatch(/^ {4}env:/m);
  });

  it("pipes through tee under pipefail and writes the summary in an always() step", () => {
    expect(applyStep).toContain("set -o pipefail");
    expect(applyStep).toMatch(/node tools\/lockdown\.mjs "\$\{args\[@\]\}" 2>&1 \| tee "\$RUNNER_TEMP\/lockdown\.txt"/);
    const summary = yml.split(/^ {6}- name: Summary\n/m)[1] ?? "";
    expect(summary).toMatch(/^ {8}if: always\(\)$/m);
    expect(summary).toContain("GITHUB_STEP_SUMMARY");
    expect(summary).not.toContain("secrets.");
    expect(Number(yml.match(/timeout-minutes: (\d+)/)?.[1])).toBeGreaterThanOrEqual(20);
  });

  it("pins every action by SHA with a version comment, as the other workflows do", () => {
    const uses = [...yml.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const [, spec, restOfLine] of uses) {
      expect(spec).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      expect(restOfLine).toMatch(/# v\d/);
    }
    const pinned = (file: string) =>
      new Map([...read(file).matchAll(/uses: ([\w-]+\/[\w-]+@[0-9a-f]{40})/g)].map((m) => [m[1]?.split("@")[0], m[1]]));
    const deploy = pinned(".github/workflows/deploy.yml");
    for (const [, spec] of uses) expect(deploy.get(spec?.split("@")[0]), spec).toBe(spec);
  });

  it("passes inputs through env, never interpolated into the script", () => {
    const run = applyStep.split(/^\s+run: \|\n/m)[1] ?? "";
    expect(run).not.toContain("${{");
    for (const key of ["LEVEL", "METER", "UNDO", "APPLY"])
      expect(applyStep).toContain(`${key}: \${{ inputs.${key.toLowerCase()} }}`);
  });
});

describe("docs", () => {
  const docs = read("docs/lockdown.md");
  it("covers every rung, the phone, the Mac, undo, step 0 and the tokens", () => {
    for (const level of LEVELS) expect(docs).toContain(`### ${level}`);
    for (const word of ["phone", "mac", "undo", "workflow_dispatch", "step 0", "leaked deploy token", "migration 0005"])
      expect(docs.toLowerCase()).toContain(word);
  });

  it("names every permission the table needs, with LOCKDOWN_CF_TOKEN and an endpoint for each", () => {
    const names = new Set([
      ...table.held,
      ...Object.values(table.rungs).flatMap((r) => r.calls.map((c) => c.permission)),
    ]);
    for (const permission of names) {
      for (const part of permission.split(" and ")) expect(docs, part).toContain(part);
    }
    expect(docs).toContain("LOCKDOWN_CF_TOKEN");
    for (const endpoint of ["GET /zones", "/subdomain", "/schedules", "batch terminate", "database query"])
      expect(docs, endpoint).toContain(endpoint);
  });

  it("documents the exit codes, the undo's reach and removing hand-set floors", () => {
    expect(docs).toMatch(/3 done but deploys are not frozen/);
    expect(docs).toMatch(/Remove any `SWITCH_` variable you set by hand/);
    expect(docs).toMatch(/lockdown:L1.*lockdown:L<n>/);
  });

  it("links to the spend docs for the switch names rather than listing their meaning", () => {
    expect(docs).toContain("(spend.md)");
    expect(docs).not.toMatch(/[–—]/);
  });

  it("ADR 0030 says why, what it replaces and how to remove it", () => {
    const adr = read("docs/adr/0030-lockdown.md");
    for (const word of ["Context", "Decision", "Replaces", "Remove"]) expect(adr).toContain(word);
    expect(adr).not.toMatch(/[–—]/);
  });
});

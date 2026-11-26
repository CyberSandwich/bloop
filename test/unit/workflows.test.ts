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

/**
 * The jobs that hold the Cloudflare token, and the composite action they run, are pinned byte for byte: nothing is
 * parsed, so no YAML form can slip a step past the guard. Any change to one fails this test until the block below is
 * updated on purpose, and that update is the review point (docs/architecture.md section 12).
 */
const PINNED: Record<string, string[]> = {
  "deploy.yml deploy": [
    "  deploy:",
    "    needs: check",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    environment: production",
    "    steps:",
    "      # A secret cannot be tested in an `if`, so this step reads it and reports whether it exists.",
    "      - name: Check for Cloudflare secrets",
    "        id: gate",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "        run: |",
    '          if [ -n "$CLOUDFLARE_API_TOKEN" ]; then echo "has=true" >> "$GITHUB_OUTPUT"; else echo "No CLOUDFLARE_API_TOKEN; skipping deploy."; fi',
    "      - if: steps.gate.outputs.has == 'true'",
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
    "      - if: steps.gate.outputs.has == 'true'",
    "        uses: ./.github/actions/prebuilt-dist",
    "      # One step holds the token, so it is in no other step's environment. The R2 lifecycle rules are a one-off",
    "      # step in docs/setup.md, not part of a deploy. A failing line stops the step.",
    "      - if: steps.gate.outputs.has == 'true'",
    "        run: |",
    "          node tools/pinned-wrangler.mjs d1 migrations apply DB --remote",
    "          node tools/pinned-wrangler.mjs deploy",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  ],
  "staging.yml staging": [
    "  staging:",
    "    if: github.ref_name == 'staging'",
    "    needs: check",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    environment: staging",
    "    steps:",
    "      # A secret cannot be tested in an `if`, so this step reads it and reports whether it exists.",
    "      - name: Check for Cloudflare secrets",
    "        id: gate",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "        run: |",
    '          if [ -n "$CLOUDFLARE_API_TOKEN" ]; then echo "has=true" >> "$GITHUB_OUTPUT"; else echo "Staging skipped: no CLOUDFLARE_API_TOKEN in the staging environment."; fi',
    "      - if: steps.gate.outputs.has == 'true'",
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
    "      - if: steps.gate.outputs.has == 'true'",
    "        uses: ./.github/actions/prebuilt-dist",
    "      - name: Look for the staging resources",
    "        id: resources",
    "        if: steps.gate.outputs.has == 'true'",
    "        run: node tools/staging.mjs ready",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    "      - name: Deploy",
    "        if: steps.resources.outputs.ready == 'true'",
    "        run: node tools/staging.mjs deploy",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    "          STAGING_D1_ID: ${{ steps.resources.outputs.d1_id }}",
  ],
  "action.yml": [
    "name: prebuilt dist",
    "description: >-",
    "  Installs from the lockfile without scripts, downloads the check job's dist/ artifact and swaps wrangler.jsonc's build",
    "  command for the manifest assertion. The deploy jobs, the staging job and the CI rehearsal all use it, so the rehearsal",
    "  runs the steps a deploy runs (docs/architecture.md section 12). Run actions/checkout first.",
    "",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
    "      with:",
    "        node-version-file: .nvmrc",
    "        # No restored npm cache: the check job's saved cache is written by third-party code.",
    "        package-manager-cache: false",
    "    - run: npm ci --ignore-scripts",
    "      shell: bash",
    "    - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7.0.0",
    "      with:",
    "        name: dist",
    "        path: dist",
    "    - run: node tools/prebuilt.mjs rewrite",
    "      shell: bash",
  ],
};

/** The actions any workflow may use, by pinned commit, and the one local action. */
const ALLOWED_USES = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
  "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
  "./.github/actions/prebuilt-dist",
];

/** The text of job `name`: its key line up to the next job key or comment at the same indent. */
function jobBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const from = lines.indexOf(`  ${name}:`);
  if (from < 0) return "";
  let to = from + 1;
  while (to < lines.length && !/^ {2}(#|[\w-]+:\s*$)/.test(lines[to] ?? "")) to++;
  return lines.slice(from, to).join("\n").trimEnd();
}

/** Every job key of a workflow. */
function jobNames(text: string): string[] {
  const lines = text.split("\n");
  return lines.slice(lines.indexOf("jobs:") + 1).flatMap((line) => /^ {2}([\w-]+):\s*$/.exec(line)?.[1] ?? []);
}

/** Why the workflows and the action could run code other than what is pinned beside the token. */
function pinProblems(files: Record<string, string>, action: string): string[] {
  const problems: string[] = [];
  const found = new Set<string>();
  for (const [f, text] of Object.entries(files)) {
    for (const name of jobNames(text)) {
      const body = jobBlock(text, name);
      if (!/CLOUDFLARE_API_TOKEN|^ {4}environment:/m.test(body)) continue;
      found.add(`${f} ${name}`);
      if (body !== PINNED[`${f} ${name}`]?.join("\n")) problems.push(`${f} ${name} differs from its pin`);
    }
    if (/^ {0,4}(defaults|container|services):/m.test(text)) problems.push(`${f} has defaults, container or services`);
  }
  for (const pin of Object.keys(PINNED)) {
    if (pin !== "action.yml" && !found.has(pin)) problems.push(`${pin} is pinned but no longer a token job`);
  }
  for (const key of found) if (!(key in PINNED)) problems.push(`${key} holds the token and is not pinned`);
  if (action.trimEnd() !== PINNED["action.yml"]?.join("\n")) problems.push("action.yml differs from its pin");
  for (const [f, text] of [...Object.entries(files), ["action.yml", action] as const]) {
    for (const use of text.matchAll(/\buses:\s*(\S+)/g)) {
      if (!ALLOWED_USES.includes(use[1] ?? "")) problems.push(`${f} uses ${use[1]}`);
    }
  }
  return problems;
}

describe("SITE-05 third-party code never shares a job with the token", () => {
  const files = Object.fromEntries(
    readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, readFileSync(new URL(f, dir), "utf8")]),
  );
  const action = readFileSync(new URL("../actions/prebuilt-dist/action.yml", dir), "utf8");

  it("SITE-05 token jobs: every job that names an environment or the token, and the action they run, is exactly its pinned text", () => {
    expect(pinProblems(files, action)).toEqual([]);
    expect(Object.keys(PINNED)).toHaveLength(3);
  });

  it("SITE-05 token jobs: the guard refuses each change to a token job, the action, or a workflow's defaults and uses", () => {
    const deploy = files["deploy.yml"] ?? "";
    const withFiles = (name: string, text: string) => pinProblems({ ...files, [name]: text }, action);
    const cases: [string, string[]][] = [
      [
        "a command appended to a run",
        withFiles("deploy.yml", deploy.replace("mjs deploy\n", "mjs deploy && npx evil\n")),
      ],
      [
        "a changed indentation",
        withFiles("deploy.yml", deploy.replace("    environment: production", "     environment: production")),
      ],
      [
        "a working-directory",
        withFiles(
          "deploy.yml",
          deploy.replace(
            "        uses: ./.github/actions/prebuilt-dist",
            "        uses: ./.github/actions/prebuilt-dist\n        working-directory: dist",
          ),
        ),
      ],
      [
        "a job container",
        withFiles(
          "deploy.yml",
          deploy.replace("    environment: production", "    environment: production\n    container: evil:1"),
        ),
      ],
      [
        "workflow defaults",
        withFiles("deploy.yml", deploy.replace("jobs:", "defaults:\n  run:\n    shell: npx foo {0}\njobs:")),
      ],
      [
        "a service",
        withFiles(
          "ci.yml",
          `${files["ci.yml"]}`.replace("  rehearsal:", "  rehearsal:\n    services:\n      x:\n        image: evil"),
        ),
      ],
      [
        "a third-party action in any job",
        withFiles(
          "ci.yml",
          `${files["ci.yml"]}`.replace(
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "evil/action@3d3c42e5aac5ba805825da76410c181273ba90b1",
          ),
        ),
      ],
      [
        "a tag instead of a commit",
        withFiles(
          "ci.yml",
          `${files["ci.yml"]}`.replace(
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "actions/checkout@v4",
          ),
        ),
      ],
      [
        "a reusable workflow job",
        withFiles("ci.yml", `${files["ci.yml"]}\n  more:\n    uses: org/repo/.github/workflows/x.yml@main\n`),
      ],
      [
        "a token job in a new workflow",
        withFiles(
          "new.yml",
          "jobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
        ),
      ],
      [
        "an environment in a new job",
        withFiles(
          "new.yml",
          "jobs:\n  go:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: npx evil\n",
        ),
      ],
    ];
    for (const [name, problems] of cases) expect(problems, name).not.toEqual([]);
    const changedAction = action.replace("npm ci --ignore-scripts", "npm ci");
    expect(pinProblems(files, changedAction)).toEqual(["action.yml differs from its pin"]);
  });

  it("SITE-05 token jobs: the check job has no environment and no secret and hands dist/ over with its hidden files", () => {
    for (const f of ["deploy.yml", "staging.yml", "ci.yml"]) {
      const check = jobBlock(files[f] ?? "", "check");
      expect(check, f).not.toMatch(/environment:|secrets\.|CLOUDFLARE/);
      expect(check, f).toContain("      - run: node tools/prebuilt.mjs manifest\n");
      expect(check, f).toContain("include-hidden-files: true");
    }
  });

  it("SITE-05 token jobs: the rehearsal runs on every branch with no environment and no token, then dry-runs both configs", () => {
    const ci = files["ci.yml"] ?? "";
    const rehearsal = jobBlock(ci, "rehearsal");
    expect(rehearsal).toContain("needs: check");
    expect(rehearsal).not.toMatch(/environment:|secrets\.|CLOUDFLARE/);
    expect(rehearsal).toContain("uses: ./.github/actions/prebuilt-dist");
    expect(rehearsal).toContain("node tools/prebuilt.mjs assert");
    expect(rehearsal).toContain("node tools/pinned-wrangler.mjs deploy --dry-run --outdir");
    expect(rehearsal).toContain("node tools/pinned-wrangler.mjs deploy --dry-run -e staging --outdir");
    expect(ci).not.toMatch(/^on:\n {2}push:\n {4}branches/m);
  });

  it("SITE-05 token jobs: wrangler.jsonc's build block is the one the deploy jobs know how to swap", () => {
    const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    expect(() => withPrebuilt(config)).not.toThrow();
    expect(withPrebuilt(config)).toContain("node tools/prebuilt.mjs assert");
    expect(() => withPrebuilt("{}")).toThrow(/no build block/);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withPrebuilt } from "../../tools/prebuilt.mjs";

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

/** What makes a job a token job: an environment, the token, or any use of the secrets context. */
const TOKEN_JOB = /environment["']?\s*:|CLOUDFLARE|\$\{\{[^}]*secrets/i;

/** A job key: the only line shape allowed at two spaces of indent under `jobs:`. */
const JOB_KEY = /^ {2}([\w-]+):$/;

/** Every job of a workflow with its text, from its key line to the next job key (comments in between belong to it), and
 * the lines that are not in a plain block-style layout. Nothing is parsed: a form this does not read is a problem. */
function jobsOf(text: string): { jobs: Record<string, string>; problems: string[] } {
  const lines = text.split("\n");
  const jobs: Record<string, string> = {};
  const problems: string[] = [];
  if (/[\r\t]/.test(text)) problems.push("carriage return or tab");
  const start = lines.indexOf("jobs:");
  if (start < 0) return { jobs, problems: [...problems, "no `jobs:` line"] };
  let name = "";
  for (const line of lines.slice(start + 1)) {
    const key = JOB_KEY.exec(line);
    const indent = line.length - line.trimStart().length;
    if (key) {
      name = key[1] ?? "";
      jobs[name] = line;
      continue;
    }
    if (line.trim() !== "" && !line.trimStart().startsWith("#") && indent <= 2) problems.push(`not a job key: ${line}`);
    if (name) jobs[name] += `\n${line}`;
  }
  for (const [job, body] of Object.entries(jobs)) jobs[job] = body.trimEnd();
  return { jobs, problems };
}

/** Why the workflows and the action could run code other than what is pinned beside the token. */
function pinProblems(files: Record<string, string>, action: string): string[] {
  const problems: string[] = [];
  const found = new Set<string>();
  for (const [f, text] of Object.entries(files)) {
    const { jobs, problems: layout } = jobsOf(text);
    problems.push(...layout.map((p) => `${f}: ${p}`));
    for (const [name, body] of Object.entries(jobs)) {
      if (!TOKEN_JOB.test(body)) continue;
      found.add(`${f} ${name}`);
      if (body !== PINNED[`${f} ${name}`]?.join("\n")) problems.push(`${f} ${name} differs from its pin`);
    }
  }
  for (const pin of Object.keys(PINNED)) {
    if (pin !== "action.yml" && !found.has(pin)) problems.push(`${pin} is pinned but no longer a token job`);
  }
  for (const key of found) if (!(key in PINNED)) problems.push(`${key} holds the token and is not pinned`);
  if (action.trimEnd() !== PINNED["action.yml"]?.join("\n")) problems.push("action.yml differs from its pin");
  for (const [f, text] of [...Object.entries(files), ["action.yml", action] as const]) {
    if (/[\r\t]/.test(text)) problems.push(`${f}: carriage return or tab`);
    if (/^\s*["']?(defaults|container|services)["']?\s*:/m.test(text))
      problems.push(`${f} has defaults, container or services`);
    for (const use of text.matchAll(/["']?\buses["']?\s*:\s*["']?([^\s"'}]+)/g)) {
      if (!ALLOWED_USES.includes(use[1] ?? "")) problems.push(`${f} uses ${use[1]}`);
    }
  }
  return problems;
}

/** The text of job `name` in a workflow. */
const jobBlock = (text: string, name: string): string => jobsOf(text).jobs[name] ?? "";

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

  it("SITE-05 token jobs: the guard refuses each way to change a token job, add one, or run another action", () => {
    const deploy = files["deploy.yml"] ?? "";
    const ci = files["ci.yml"] ?? "";
    const edit = (name: string, text: string, replace: [string, string]) => {
      const changed = text.replace(...replace);
      expect(changed, `${name} edit applies`).not.toBe(text);
      return pinProblems({ ...files, [name.split(" ")[0] ?? ""]: changed }, action).join("\n");
    };
    const addJob = (job: string) => pinProblems({ ...files, "new.yml": `jobs:\n${job}` }, action).join("\n");
    const sha = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
    const cases: [string, string, string][] = [
      [
        "a command appended to a run",
        edit("deploy.yml", deploy, ["mjs deploy\n", "mjs deploy && npx evil\n"]),
        "deploy.yml deploy differs",
      ],
      [
        "a step after a two-space comment",
        edit("deploy.yml", deploy, ["mjs deploy\n", "mjs deploy\n  # end\n      - run: npx evil\n"]),
        "deploy.yml deploy differs",
      ],
      [
        "a changed indentation",
        edit("deploy.yml", deploy, ["    environment: production", "     environment: production"]),
        "deploy.yml deploy differs",
      ],
      [
        "a working-directory",
        edit("deploy.yml", deploy, [
          "        uses: ./.github/actions/prebuilt-dist",
          "        uses: ./.github/actions/prebuilt-dist\n        working-directory: dist",
        ]),
        "deploy.yml deploy differs",
      ],
      [
        "a job container",
        edit("deploy.yml", deploy, [
          "    environment: production",
          "    environment: production\n    container: evil:1",
        ]),
        "has defaults, container or services",
      ],
      [
        "workflow defaults",
        edit("deploy.yml", deploy, ["jobs:", "defaults:\n  run:\n    shell: npx foo {0}\njobs:"]),
        "has defaults, container or services",
      ],
      [
        "quoted workflow defaults",
        edit("deploy.yml", deploy, ["jobs:", '"defaults":\n  run:\n    shell: npx foo {0}\njobs:']),
        "has defaults, container or services",
      ],
      [
        "defaults with a space before the colon",
        edit("deploy.yml", deploy, ["jobs:", "defaults :\n  run:\n    shell: npx foo {0}\njobs:"]),
        "has defaults, container or services",
      ],
      [
        "a service",
        edit("ci.yml", ci, ["  rehearsal:", "  rehearsal:\n    services:\n      x:\n        image: evil"]),
        "has defaults, container or services",
      ],
      [
        "a third-party action",
        edit("ci.yml", ci, [sha, "evil/action@3d3c42e5aac5ba805825da76410c181273ba90b1"]),
        "ci.yml uses evil/action@",
      ],
      [
        "a tag instead of a commit",
        edit("ci.yml", ci, [sha, "actions/checkout@v4"]),
        "ci.yml uses actions/checkout@v4",
      ],
      [
        "a quoted uses key",
        edit("ci.yml", ci, ["  rehearsal:\n", '  rehearsal:\n    steps:\n      - "uses": evil/x@1\n']),
        "ci.yml uses evil/x@1",
      ],
      [
        "a flow-style step",
        edit("ci.yml", ci, ["  rehearsal:\n", "  rehearsal:\n    steps:\n      - { uses: evil/y@1 }\n"]),
        "ci.yml uses evil/y@1",
      ],
      [
        "a reusable workflow job",
        addJob("  more:\n    uses: org/repo/.github/workflows/x.yml@main\n"),
        "uses org/repo/.github/workflows/x.yml@main",
      ],
      [
        "a job using the token secret",
        addJob(
          "  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.CLOUDFLARE_API_TOKEN }}\n",
        ),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "toJSON of all secrets",
        addJob("  go:\n    steps:\n      - run: echo ${{ toJSON(secrets) }}\n"),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "an environment in a new job",
        addJob("  go:\n    environment: production\n    steps:\n      - run: npx evil\n"),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "an environment indented six spaces",
        addJob("  go:\n    steps:\n      - run: npx evil\n      environment: production\n"),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "a quoted environment key",
        addJob('  go:\n    "environment": production\n    steps:\n      - run: npx evil\n'),
        "new.yml go holds the token and is not pinned",
      ],
      [
        "a space before the environment colon",
        addJob("  go:\n    environment : production\n    steps:\n      - run: npx evil\n"),
        "new.yml go holds the token and is not pinned",
      ],
      ["a comment after the job key", addJob("  go: # x\n    environment: production\n"), "not a job key:   go: # x"],
      ["a quoted job key", addJob('  "go":\n    environment: production\n'), 'not a job key:   "go":'],
      ["a flow-style job", addJob("  go: { environment: production, steps: [] }\n"), "not a job key"],
      [
        "a CRLF workflow",
        pinProblems({ ...files, "deploy.yml": deploy.replaceAll("\n", "\r\n") }, action).join("\n"),
        "carriage return or tab",
      ],
    ];
    for (const [name, problems, expected] of cases) expect(problems, name).toContain(expected);
    expect(pinProblems(files, action.replace("npm ci --ignore-scripts", "npm ci"))).toEqual([
      "action.yml differs from its pin",
    ]);
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
